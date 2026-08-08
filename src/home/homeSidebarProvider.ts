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
body { padding: 4px 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
button { width: 100%; padding: 5px 8px; border: 0; border-radius: 2px; text-align: left; cursor: pointer; color: var(--vscode-foreground); background: transparent; }
button:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
	<button onclick="openHome()">⌂&nbsp; Home</button>
	<script>
		const vscode = acquireVsCodeApi();
		function openHome() { vscode.postMessage({ command: "openHome" }); }
	</script>
</body>
</html>`;
	}
}
