// Raw document
export {
  parseZmxDocument,
  findRecord,
  findRecords,
  firstValue,
  hasRecord,
  numericValue,
} from './document.ts';
export type { ZmxDocument, ZmxRecord, ZmxSurfaceBlock } from './document.ts';

// Encoding
export { decodeZmx, detectEncoding } from './decode.ts';

// Writing the model back out
export { exportZmx, systemToZmxDocument, formatZmxDocument, ZmxExportError } from './export.ts';
export type { ZmxExportOptions, ZmxExportResult } from './export.ts';

// Mapping onto the optical-core model
export {
  importZmx,
  zmxDocumentToSystem,
  ZmxImportError,
  UNKNOWN_GLASS_INDEX,
  MODEL_GLASS_NAME,
  MIRROR_GLASS_NAME,
} from './import.ts';
export type { ZmxImportOptions, ZmxImportResult, ZmxGlassReference } from './import.ts';
export { zmxTokenRole } from './import.ts';
export type { ZmxTokenRole } from './import.ts';
