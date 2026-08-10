import type { GitAwareStatus } from "../types";

export function gitStatusLabel(status: GitAwareStatus): string {
	switch (status) {
		case "new":
			return "New";
		case "modified":
			return "Modified";
		case "ahead":
			return "Ahead";
		case "merged":
			return "Merged";
		case "unknown":
			return "Unknown";
	}
}
