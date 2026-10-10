import { copyButtonHtml } from "@kintsugi/design-system/copy-button";
import { qrCodeButtonHtml, qrCodeDialogHtml } from "@kintsugi/design-system/qr-code";
import { escapeHtml } from "@kintsugi/shared";

/** Link, copy and QR actions for the Kintsugi URL. Render outside forms. */
export function kintsugiUrlHtml(kintsugiUrl: string, qrDialogId: string): string {
  return `<div class="kintsugi-url"><a href="${escapeHtml(kintsugiUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(kintsugiUrl)}</a>${copyButtonHtml({ label: "Copy Kintsugi URL", copyText: kintsugiUrl })}${qrCodeButtonHtml(qrDialogId, "Show QR code")}</div>${qrCodeDialogHtml(qrDialogId, kintsugiUrl)}`;
}
