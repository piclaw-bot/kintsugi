export type OfficeKind = "docx" | "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" | "pptx" | "csv" | "tsv";
export function officeFileKind(path: string): OfficeKind | undefined {
  if (!path || path.length > 4096 || path.includes("\0")) return undefined;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "docx": case "xlsx": case "xlsm": case "xlsb": case "xls": case "ods": case "pptx": case "csv": case "tsv": return extension;
    case "tab": return "tsv";
    default: return undefined;
  }
}
export const maxOfficeFileBytes = 16 * 1024 * 1024;
export const officeMimeTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", csv: "text/csv", tsv: "text/tab-separated-values",
} satisfies Record<OfficeKind, string>;
