export type SglangQualificationRecord = {
  runtimeId: string;
  qualificationStatus: "unqualified" | "measured" | "selected";
};

export function sglangIsRefused(input: {
  gfx1151QualificationRecord: SglangQualificationRecord | null;
}): boolean {
  const record = input.gfx1151QualificationRecord;
  if (record === null) {
    return true;
  }
  if (record.runtimeId !== "sglang-gfx1151") {
    return true;
  }
  return record.qualificationStatus !== "measured" && record.qualificationStatus !== "selected";
}
