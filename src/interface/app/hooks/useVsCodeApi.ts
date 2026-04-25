import { PopupMessage } from '../types/messages';

type VsCodeApi = {
	postMessage: (message: PopupMessage) => void;
};

const vscode = acquireVsCodeApi<VsCodeApi>();

export function postToHost(message: PopupMessage): void {
	vscode.postMessage(message);
}
