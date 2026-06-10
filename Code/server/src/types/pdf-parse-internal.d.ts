declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
    metadata: unknown;
  }

  export default function pdfParse(data: Buffer): Promise<PdfParseResult>;
}
