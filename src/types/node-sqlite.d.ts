/**
 * Minimal ambient types for `node:sqlite` so the project can typecheck on
 * @types/node < 22.5. Only the surface used by the codebase is declared; the
 * extension host runtime (VS Code server, Node >= 22.13) provides the module.
 */
declare module "node:sqlite" {
	export interface StatementSync {
		run(...params: unknown[]): { changes: number; lastInsertRowid: number };
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	}
	export class DatabaseSync {
		constructor(path: string, options?: { readOnly?: boolean });
		exec(sql: string): void;
		prepare(sql: string): StatementSync;
		close(): void;
	}
}
