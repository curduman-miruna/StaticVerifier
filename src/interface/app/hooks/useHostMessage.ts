import { useEffect } from 'react';
import { HostMessage } from '../types/messages';

export function useHostMessage(onMessage: (message: HostMessage) => void): void {
	useEffect(() => {
		const handler = (event: MessageEvent<HostMessage>) => {
			if (!event.data) {
				return;
			}

			onMessage(event.data);
		};

		window.addEventListener('message', handler);
		return () => {
			window.removeEventListener('message', handler);
		};
	}, [onMessage]);
}
