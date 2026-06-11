// Structured JSON logger for Lambda — one JSON object per line so CloudWatch
// Logs Insights can query fields directly. Keep a single logger per invocation
// and bind shared context (campaignId, workspaceId, ...) once.

type LogContext = Record<string, unknown>;

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /** Returns a child logger with additional bound context. */
  with(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }

  private emit(level: 'INFO' | 'WARN' | 'ERROR', message: string, extra?: LogContext) {
    const line = JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...extra,
    });
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }

  info(message: string, extra?: LogContext) {
    this.emit('INFO', message, extra);
  }

  warn(message: string, extra?: LogContext) {
    this.emit('WARN', message, extra);
  }

  error(message: string, err?: unknown, extra?: LogContext) {
    const errorFields =
      err instanceof Error
        ? { errorName: err.name, errorMessage: err.message, stack: err.stack }
        : err !== undefined
          ? { errorMessage: String(err) }
          : {};
    this.emit('ERROR', message, { ...errorFields, ...extra });
  }
}
