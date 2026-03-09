import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { SessionPanel } from './SessionPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Session Xplorer (AIsx) is now active');

    const sidebarProvider = new SidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aisx.refresh', () => {
            sidebarProvider.refresh();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'aisx.openSession',
            (sessionId: string, locator: string, source: string) => {
                SessionPanel.createOrShow(context, sessionId, locator, source);
            },
        ),
    );
}

export function deactivate() {}
