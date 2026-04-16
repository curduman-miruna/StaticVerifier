import type { InitialState } from '../../../shared/messages';

declare module '*.css';

declare global {
	function acquireVsCodeApi<T = { postMessage: (message: unknown) => void }>(): T;

	interface Window {
		__STATIC_VERIFIER_INITIAL_STATE__?: InitialState;
	}
}

export {};
