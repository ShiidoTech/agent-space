import * as vscode from "vscode";

/** Persistent top-level entry point for the Agent Space activity bar. */
export class HomeSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "agentSpace.home";

	private view?: vscode.WebviewView;

	constructor(
		private readonly onOpenHome: () => void,
		private readonly extensionUri: vscode.Uri,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "media", "webview"),
			],
		};
		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.command === "openHome") this.onOpenHome();
		});
	}

	refresh(): void {
		if (this.view) this.view.webview.html = this.getHtml();
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
.home-card { padding: 12px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.home-title { font-weight: 600; margin-bottom: 6px; }
.home-copy { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
button { width: 100%; padding: 7px 10px; border: 0; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
	<div class="home-card">
		<div class="home-title">Agent Space Home</div>
		<div class="home-copy">Global overview and project management.</div>
		<button onclick="openHome()">Open Overview</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		function openHome() { vscode.postMessage({ command: "openHome" }); }
	</script>
</body>
</html>`;
	}
}
