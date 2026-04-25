import type { HTMLAttributes, PropsWithChildren } from 'react';
import { cx } from './cx';

type CardProps = PropsWithChildren<HTMLAttributes<HTMLDivElement>>;

export function Card({ children, className, ...props }: CardProps) {
	return (
		<div className={cx('sv-ui-card', className)} {...props}>
			{children}
		</div>
	);
}
