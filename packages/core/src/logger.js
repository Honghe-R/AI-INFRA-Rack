import { redact } from './redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON logging with mandatory redaction.
 *
 * Field layout follows the `StructuredLog` shape in the Non-Functional
 * Requirements. Every field bag passes through the redactor, so a caller cannot
 * leak a credential by logging an object it did not inspect.
 */
export function createLogger({
  service = 'app',
  version = '0.0.0',
  level = 'info',
  sink = console,
  baseFields = {},
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (severity, message, fields = {}, correlationId) => {
    if (LEVELS[severity] < threshold) return;
    const record = {
      ...baseFields,
      ...redact(fields),
      timestamp: new Date().toISOString(),
      level: severity,
      service,
      service_version: version,
      message,
      ...(correlationId ? { correlation_id: correlationId } : {}),
    };
    const line = JSON.stringify(record);
    if (severity === 'error') sink.error(line);
    else if (severity === 'warn') sink.warn(line);
    else sink.log(line);
  };

  return {
    level,
    debug: (message, fields, correlationId) => emit('debug', message, fields, correlationId),
    info: (message, fields, correlationId) => emit('info', message, fields, correlationId),
    warn: (message, fields, correlationId) => emit('warn', message, fields, correlationId),
    error: (message, fields, correlationId) => emit('error', message, fields, correlationId),
  };
}
