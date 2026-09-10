type LogContext = Record<string, unknown>;

export const log = {
  info: (message: string, context?: LogContext) => {
    console.info(message, context ?? {});
  },
  debug: (message: string, context?: LogContext) => {
    console.debug(message, context ?? {});
  },
  error: (message: string, error?: unknown, context?: LogContext) => {
    console.error(message, error ?? {}, context ?? {});
  },
};

export default log;
