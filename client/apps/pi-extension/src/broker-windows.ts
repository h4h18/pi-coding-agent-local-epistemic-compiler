import koffi from "koffi";
import {
  filetimePartsToRfc3339,
  newGeneralId,
  type FiletimeParts,
  type ProcessClaim,
  type ProcessTimesProbe,
} from "./broker-client.js";

type GetProcessTimesFn = (
  handle: unknown,
  creation: FiletimeParts,
  exit: FiletimeParts,
  kernel: FiletimeParts,
  user: FiletimeParts,
) => boolean;

type Kernel32Api = {
  GetCurrentProcess: () => unknown;
  GetProcessTimes: GetProcessTimesFn;
  CloseHandle: (handle: unknown) => boolean;
};

type Advapi32Api = {
  OpenProcessToken: (process: unknown, access: number, tokenOut: unknown[]) => boolean;
  GetTokenInformation: (
    token: unknown,
    infoClass: number,
    valueOut: unknown[],
    length: number,
    neededOut: unknown[],
  ) => boolean;
};

const TOKEN_QUERY = 0x0008;
const TOKEN_HAS_RESTRICTIONS = 21;
const TOKEN_IS_APP_CONTAINER = 29;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let memoizedCreationTime: string | undefined;
let kernel32Api: Kernel32Api | undefined;
let advapi32Api: Advapi32Api | undefined;

function loadKernel32(): Kernel32Api {
  if (kernel32Api !== undefined) {
    return kernel32Api;
  }
  if (process.platform !== "win32") {
    throw new Error("GetProcessTimes requires win32");
  }
  const kernel32 = koffi.load("kernel32.dll");
  koffi.struct("FILETIME", {
    dwLowDateTime: "uint32",
    dwHighDateTime: "uint32",
  });
  const api: Kernel32Api = {
    GetCurrentProcess: kernel32.func(
      "void * __stdcall GetCurrentProcess()",
    ) as Kernel32Api["GetCurrentProcess"],
    GetProcessTimes: kernel32.func(
      "bool __stdcall GetProcessTimes(void *hProcess, _Out_ FILETIME *lpCreationTime, _Out_ FILETIME *lpExitTime, _Out_ FILETIME *lpKernelTime, _Out_ FILETIME *lpUserTime)",
    ) as GetProcessTimesFn,
    CloseHandle: kernel32.func(
      "bool __stdcall CloseHandle(void *hObject)",
    ) as Kernel32Api["CloseHandle"],
  };
  kernel32Api = api;
  return api;
}

function loadAdvapi32(): Advapi32Api {
  if (advapi32Api !== undefined) {
    return advapi32Api;
  }
  if (process.platform !== "win32") {
    throw new Error("token probe requires win32");
  }
  const advapi32 = koffi.load("advapi32.dll");
  const api: Advapi32Api = {
    OpenProcessToken: advapi32.func(
      "bool __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)",
    ) as Advapi32Api["OpenProcessToken"],
    GetTokenInformation: advapi32.func(
      "bool __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, _Out_ uint32 *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)",
    ) as Advapi32Api["GetTokenInformation"],
  };
  advapi32Api = api;
  return api;
}

function tokenDword(token: unknown, infoClass: number): number | undefined {
  const advapi = loadAdvapi32();
  const value: unknown[] = [null];
  const needed: unknown[] = [null];
  const ok = advapi.GetTokenInformation(token, infoClass, value, 4, needed);
  if (!ok) {
    return undefined;
  }
  const dword = value[0];
  return typeof dword === "number" ? dword : undefined;
}

export function readCurrentProcessIsAppContainer(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const kernel = loadKernel32();
    const advapi = loadAdvapi32();
    const tokenOut: unknown[] = [null];
    const opened = advapi.OpenProcessToken(kernel.GetCurrentProcess(), TOKEN_QUERY, tokenOut);
    const token = tokenOut[0];
    if (!opened || token === undefined || token === null) {
      return false;
    }
    try {
      const appContainer = tokenDword(token, TOKEN_IS_APP_CONTAINER);
      const restricted = tokenDword(token, TOKEN_HAS_RESTRICTIONS);
      return appContainer !== undefined && appContainer !== 0 && restricted !== undefined && restricted !== 0;
    } finally {
      kernel.CloseHandle(token);
    }
  } catch {
    return false;
  }
}

function nativeFiletime(): FiletimeParts | undefined {
  try {
    const api = loadKernel32();
    const creation: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const exit: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const kernel: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const user: FiletimeParts = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const ok = api.GetProcessTimes(api.GetCurrentProcess(), creation, exit, kernel, user);
    if (!ok) {
      return undefined;
    }
    if (creation.dwLowDateTime === 0 && creation.dwHighDateTime === 0) {
      return undefined;
    }
    return creation;
  } catch {
    return undefined;
  }
}

export function readProcessCreationTime(probe?: ProcessTimesProbe): string {
  if (memoizedCreationTime !== undefined && probe === undefined) {
    return memoizedCreationTime;
  }
  const parts = probe !== undefined ? probe() : nativeFiletime();
  if (parts === undefined) {
    throw new Error("GetProcessTimes failed");
  }
  const formatted = filetimePartsToRfc3339(parts);
  if (!RFC3339.test(formatted)) {
    throw new Error("GetProcessTimes failed");
  }
  if (probe === undefined) {
    memoizedCreationTime = formatted;
  }
  return formatted;
}

export function createProcessClaim(probe?: ProcessTimesProbe): ProcessClaim {
  return {
    claimedProcessId: process.pid,
    claimedProcessCreationTime: readProcessCreationTime(probe),
    clientInstanceId: newGeneralId("client_"),
  };
}

export function processClaimOrInjected(
  claim: ProcessClaim | undefined,
  probe?: ProcessTimesProbe,
): ProcessClaim {
  if (claim !== undefined) {
    return claim;
  }
  return createProcessClaim(probe);
}
