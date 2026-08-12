export interface SessionInfo {
	sessionId: string;
	prompt: string;
	created: string;
	projectPath: string;
	/** Provider id, populated when a session is presented for explicit attach. */
	provider?: string;
}

export interface SessionProvider {
	toolId: string;
	scanSessions(options?: { fresh?: boolean }): SessionInfo[];
}

export interface SessionRenameAdapter {
	toolId: string;
	readName(sessionId: string): string | null;
	clearCache?(sessionId: string): void;
	dispose?(): void;
}

export interface SessionTitleProvider {
	toolId: string;
	findSessionFile(sessionId: string): string | null;
	readTitle(filePath: string): string | null;
	clearCache?(sessionId: string): void;
	dispose?(): void;
}
