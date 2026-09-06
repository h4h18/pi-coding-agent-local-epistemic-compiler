import type { ResolvedCommandSpec } from "@pi-hec/contracts";
import { guestUnshareFlags } from "../oci/backend.js";
import { guestEnvironment, type SafetyProfile } from "../protocol.js";

export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function generateMetaData(instanceId: string): string {
  return `instance-id: ${instanceId}\nhostname: ${instanceId}\nlocal-hostname: ${instanceId}\n`;
}

export function generateNetworkConfig(): string {
  return "version: 2\nethernets: {}\n";
}

export function recipeRequiresOci(capabilities: readonly string[]): boolean {
  return capabilities.some(
    (cap) => cap === "oci" || cap === "rootless-oci" || cap === "guest-rootless-runtime",
  );
}

export type GuestNetworkPlan = {
  guestIp: string;
  hostIp: string;
  proxyPort: number;
};

export function generateUserData(input: {
  command: ResolvedCommandSpec;
  safety: SafetyProfile;
  stdoutBytes: number;
  stderrBytes: number;
  ociRequired?: boolean;
  network?: GuestNetworkPlan;
  awaitInject?: boolean;
}): string {
  const execLine = [input.command.executablePath, ...input.command.argv].map(posixQuote).join(" ");
  const env = guestEnvironment({
    platform: "linux",
    commandEnvironment: input.command.environment,
    hostEnvironment: process.env as Record<string, string>,
  });
  const envLines = Object.entries(env)
    .map(([key, value]) => `export ${posixQuote(key)}=${posixQuote(value)}`)
    .join("\n");
  const nproc = Math.max(1, input.safety.processCount);
  const fsizeBlocks = Math.max(1, Math.floor(input.safety.diskBytes / 512));
  const asKb = Math.max(1024, Math.floor(input.safety.memoryBytes / 1024));
  const wallSec = Math.max(2, Math.ceil(input.safety.wallClockMillis / 1000));
  const stdoutLimit = Math.max(0, input.stdoutBytes);
  const stderrLimit = Math.max(0, input.stderrBytes);
  const netBlock =
    input.network === undefined
      ? ""
      : [
          "for iface in /sys/class/net/*; do",
          '  n=$(basename "$iface")',
          '  [ "$n" = lo ] && continue',
          '  ip link set "$n" up',
          `  ip addr add ${input.network.guestIp}/24 dev "$n" 2>/dev/null`,
          "done",
          `export http_proxy=http://${input.network.hostIp}:${String(input.network.proxyPort)}`,
          `export https_proxy=http://${input.network.hostIp}:${String(input.network.proxyPort)}`,
          `export HTTP_PROXY=http://${input.network.hostIp}:${String(input.network.proxyPort)}`,
          `export HTTPS_PROXY=http://${input.network.hostIp}:${String(input.network.proxyPort)}`,
          "export NO_PROXY=localhost,127.0.0.1",
        ].join("\n");
  const unshareCmd = guestUnshareFlags(input.network !== undefined);
  const toCmd = `timeout -s KILL ${String(wallSec)}`;
  const jobScript = `#!/bin/sh
ulimit -c 0 || exit 77
ulimit -u ${String(nproc)} || exit 77
ulimit -f ${String(fsizeBlocks)} || exit 77
ulimit -v ${String(asKb)} || exit 77
${envLines}
if [ -f /tmp/hec-secrets/env ]; then
  set -a
  . /tmp/hec-secrets/env
  set +a
fi
exec ${execLine}
`;
  const jobB64 = Buffer.from(jobScript, "utf8").toString("base64");
  const injectBlock = [
    "got=0",
    "i=0",
    "INJLINE=",
    'while [ "$i" -lt 40 ] && [ "$got" -eq 0 ]; do',
    "  i=$((i+1))",
    "  if IFS= read -t 1 -r line <&3; then",
    "    line=$(printf '%s' \"$line\" | tr -d '\\015')",
    "    echo \"$line\" | grep -q '^HEC_INJECT' || continue",
    "    INJLINE=$line",
    "    got=1",
    "  fi",
    "done",
    '[ "$got" -eq 1 ] || fail_unknown inject',
    "b64=\${INJLINE#HEC_INJECT}",
    "b64=$(printf '%s' \"$b64\" | tr -d ' \\015')",
    'if [ -n "$b64" ]; then',
    "  printf '%s' \"$b64\" | base64 -d > /tmp/hec-inj.txt || fail_unknown inject",
    "  exec 5</tmp/hec-inj.txt",
    "  while IFS= read -r pline <&5; do",
    "    pline=$(printf '%s' \"$pline\" | tr -d '\\015')",
    "    first=\${pline%% *}",
    "    rest=\${pline#* }",
    '    [ "$first" = "HEC_INJECT_END" ] && break',
    '    if [ "$first" = "ENV" ]; then',
    "      name=\${rest%% *}",
    "      valb64=\${rest#* }",
    "      decoded=$(printf '%s' \"$valb64\" | base64 -d 2>/dev/null) || fail_unknown inject",
    '      printf "%s=%s\\n" "$name" "$decoded" >> /tmp/hec-secrets/env',
    "    fi",
    '    if [ "$first" = "FILE" ]; then',
    "      rel=\${rest%% *}",
    "      restf=\${rest#* }",
    "      fileb64=\${restf#* }",
    '      echo "$rel" | grep -q "\\.\\." && fail_unknown inject',
    "      dest=/tmp/hec-secrets/$rel",
    '      mkdir -p "$(dirname "$dest")"',
    '      printf \'%s\' "$fileb64" | base64 -d > "$dest" || fail_unknown inject',
    '      chmod 0400 "$dest"',
    '      chown nobody "$dest" 2>/dev/null',
    "    fi",
    "  done",
    "  exec 5<&-",
    "  rm -f /tmp/hec-inj.txt",
    "fi",
  ].join("\n");
  return `#!/bin/sh
set +e
SERIAL=/dev/ttyS0
if [ ! -c "$SERIAL" ]; then
  if [ -c /dev/ttyS1 ]; then SERIAL=/dev/ttyS1; else SERIAL=/dev/console; fi
fi
mount -o remount,rw / 2>/dev/null
if [ -f /etc/inittab ]; then
  sed -i '/ttyS0/d' /etc/inittab
  sed -i '/ttyS1/d' /etc/inittab
  sed -i '/console/d' /etc/inittab
fi
kill -HUP 1 2>/dev/null
killall -9 getty agetty login 2>/dev/null
sleep 1
killall -9 getty agetty login 2>/dev/null
stty -F "$SERIAL" 115200 raw -echo clocal 2>/dev/null
exec 3<>"$SERIAL"
fail_unknown() {
  reason=$1
  printf 'HEC_RESULT {"ec":1,"term":"EXITED","out":"","err":"%s","nproc":0,"wrote":0,"priv":0,"ns":0,"ulimit":0}\\n' "$reason" > "$SERIAL"
  printf 'HEC_RESULT {"ec":1,"term":"EXITED","out":"","err":"%s","nproc":0,"wrote":0,"priv":0,"ns":0,"ulimit":0}\\n' "$reason" >&3
  sleep 1
  poweroff -f
  exit 1
}
mkdir -p /media/cidata /tmp/hec-work /tmp/hec-secrets /tmp/hec-inject
mount -t tmpfs -o size=1m,mode=700 tmpfs /tmp/hec-secrets || fail_unknown ulimit
${netBlock}
for dev in /dev/sdb1 /dev/sda2 /dev/nvme0n2p1 /dev/vdb1; do
  mount -t vfat "$dev" /media/cidata 2>/dev/null && break
done
if [ ! -f /media/cidata/user-data ]; then
  blkid | while read -r line; do
    echo "$line" | grep -qi 'LABEL=.CIDATA' || continue
    dev=\${line%%:*}
    mount -t vfat "$dev" /media/cidata 2>/dev/null && break
  done
fi
cd /tmp/hec-work || cd /tmp
ulimit -c 0 || fail_unknown ulimit
if [ -w /proc/sys/kernel/yama/ptrace_scope ]; then
  echo 3 > /proc/sys/kernel/yama/ptrace_scope || fail_unknown ulimit
fi
if ! id nobody >/dev/null 2>&1; then
  adduser -D -H -s /bin/sh nobody || fail_unknown priv
fi
if ! su -s /bin/sh nobody -c true >/dev/null 2>&1 && ! su -s /bin/sh -c true nobody >/dev/null 2>&1; then
  fail_unknown priv
fi
killall -9 getty agetty login 2>/dev/null
printf 'HEC_READY\\n' > "$SERIAL"
printf 'HEC_READY\\n' >&3
: > /tmp/hec-secrets/env
${injectBlock}
chown -R nobody /tmp/hec-secrets 2>/dev/null
chmod 700 /tmp/hec-secrets
chmod 400 /tmp/hec-secrets/env 2>/dev/null
printf '%s' '${jobB64}' | base64 -d > /tmp/hec-job.sh || fail_unknown priv
chmod 755 /tmp/hec-job.sh
: > /tmp/hec.out
: > /tmp/hec.err
TO="${toCmd}"
ns=0
command -v unshare >/dev/null 2>&1 || fail_unknown ns
if ! timeout -s KILL 3 su -s /bin/sh nobody -c ${posixQuote(`${unshareCmd} true`)} >/dev/null 2>&1; then
  fail_unknown ns
fi
ns=1
su -s /bin/sh nobody -c ${posixQuote(`${unshareCmd} ${toCmd} sh /tmp/hec-job.sh`)} >/tmp/hec.out 2>/tmp/hec.err
ec=$?
if [ "$ec" -eq 77 ]; then
  fail_unknown ulimit
fi
nproc_now=$(ps | awk '$2=="nobody"{c++} END{print c+0}')
[ -n "$nproc_now" ] || nproc_now=0
priv=1
term=EXITED
if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ] || [ "$ec" -eq 143 ] || [ "$ec" -eq 152 ]; then
  term=SAFETY_LIMIT
fi
wrote=0
if [ -f /tmp/fill ]; then
  wrote=$(wc -c < /tmp/fill 2>/dev/null | tr -d ' ')
fi
[ -n "$wrote" ] || wrote=0
head -c ${String(stdoutLimit)} /tmp/hec.out > /tmp/hec.out.b 2>/dev/null
head -c ${String(stderrLimit)} /tmp/hec.err > /tmp/hec.err.b 2>/dev/null
out=$(base64 /tmp/hec.out.b 2>/dev/null | tr -d '\\n')
err=$(base64 /tmp/hec.err.b 2>/dev/null | tr -d '\\n')
for f in /tmp/hec-secrets/*; do
  [ -f "$f" ] || continue
  dd if=/dev/zero of="$f" bs=4096 count=1 conv=notrunc 2>/dev/null
  rm -f "$f"
done
umount /tmp/hec-secrets 2>/dev/null
printf 'HEC_RESULT {"ec":%s,"term":"%s","out":"%s","err":"%s","nproc":%s,"wrote":%s,"priv":%s,"ns":%s,"ulimit":1}\\n' "$ec" "$term" "$out" "$err" "$nproc_now" "$wrote" "$priv" "$ns" > "$SERIAL"
printf 'HEC_RESULT {"ec":%s,"term":"%s","out":"%s","err":"%s","nproc":%s,"wrote":%s,"priv":%s,"ns":%s,"ulimit":1}\\n' "$ec" "$term" "$out" "$err" "$nproc_now" "$wrote" "$priv" "$ns" >&3
sleep 1
poweroff -f
`;
}
