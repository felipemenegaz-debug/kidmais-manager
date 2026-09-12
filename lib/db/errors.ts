export type PostgresErrorLike = Error & {
  code?: string;
  constraint?: string;
  detail?: string;
};

export function isPostgresError(error: unknown): error is PostgresErrorLike {
  return error instanceof Error && "code" in error;
}

export function isUniqueViolation(error: unknown, constraint?: string) {
  if (!isPostgresError(error) || error.code !== "23505") return false;
  return constraint ? error.constraint === constraint : true;
}

export function isForeignKeyViolation(error: unknown) {
  return isPostgresError(error) && error.code === "23503";
}

export function isCheckViolation(error: unknown) {
  return isPostgresError(error) && error.code === "23514";
}
