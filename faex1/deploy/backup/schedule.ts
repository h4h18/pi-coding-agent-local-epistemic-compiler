export const RESTIC_PIN = "0.19.1" as const;

export const BACKUP_SCHEDULE = {
  afterTerminalRunAndSuccessfulApply: "on-terminal",
  hourly: "hourly",
  dailyIntegrity: "daily-integrity",
  weeklyCasScrub: "weekly-cas-scrub",
  monthlyFullRead: "monthly-full-read",
  quarterlyRestoreDrill: "quarterly-restore-drill",
} as const;

export type BackupScheduleKind = (typeof BACKUP_SCHEDULE)[keyof typeof BACKUP_SCHEDULE];

export const SYSTEMD_ON_CALENDAR = {
  hourly: "hourly",
  "daily-integrity": "*-*-* 03:15:00",
  "weekly-cas-scrub": "Mon *-*-* 04:00:00",
  "monthly-full-read": "*-*-01 05:00:00",
  "quarterly-restore-drill": "*-01,04,07,10-01 06:00:00",
} as const;

export const WINDOWS_TRIGGERS = {
  hourly: { schedule: "HOURLY", modifier: 1 },
  "daily-integrity": { schedule: "DAILY", modifier: 1, start: "03:15" },
  "weekly-cas-scrub": { schedule: "WEEKLY", modifier: 1, days: "MON", start: "04:00" },
  "monthly-full-read": { schedule: "MONTHLY", modifier: 1, days: 1, start: "05:00" },
  "quarterly-restore-drill": { schedule: "MONTHLY", modifier: 3, days: 1, start: "06:00" },
} as const;
