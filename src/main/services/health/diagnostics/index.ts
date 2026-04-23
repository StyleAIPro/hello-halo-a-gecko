/**
 * Diagnostics Module
 *
 * Exports diagnostic collection and reporting functions.
 */

// Collector
export { collectDiagnosticReport } from './collector';

// Sanitizer
export { sanitizeReport, sanitizeString, sanitizeUrl } from './sanitizer';

// Reporter
export { generateReport, exportReport, formatReportAsText } from './reporter';
