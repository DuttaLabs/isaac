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

// Mapping onto the optical-core model
export { importZmx, zmxDocumentToSystem, ZmxImportError, UNKNOWN_GLASS_INDEX } from './import.ts';
export type { ZmxImportOptions, ZmxImportResult, ZmxGlassReference } from './import.ts';
