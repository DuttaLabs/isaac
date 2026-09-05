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

// Reading OpticStudio's System/Prescription Data report, and checking a system
// against one. Tool-side: `apps/web` does not use these.
export {
  parsePrescription,
  parsePrescriptionValue,
  inferMaskedDecimals,
  generalEntry,
  generalValue,
  primaryWavelengthNm,
  valueContains,
  valueMidpoint,
  DEFAULT_PRESCRIPTION_PRECISION,
} from './prescription.ts';
export type {
  ZmxPrescription,
  PrescriptionValue,
  PrescriptionPrecision,
  PrescriptionEntry,
  PrescriptionSurface,
  PrescriptionField,
  PrescriptionWavelength,
  PrescriptionCardinalRow,
  PrescriptionCardinalPoints,
} from './prescription.ts';
export { comparePrescription } from './prescription-compare.ts';
export type {
  PrescriptionCheck,
  PrescriptionComparison,
  CheckOutcome,
  CompareOptions,
} from './prescription-compare.ts';
