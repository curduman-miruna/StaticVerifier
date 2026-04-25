import type { HTMLAttributes, PropsWithChildren } from 'react';
import { cx } from './cx';

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

type BadgeProps = PropsWithChildren<
	HTMLAttributes<HTMLSpanElement> & {
		variant?: BadgeVariant;
	}
>;

const variantClass: Record<BadgeVariant, string> = {
	neutral: 'sv-ui-badge-neutral',
	success: 'sv-ui-badge-success',
	warning: 'sv-ui-badge-warning',
	danger: 'sv-ui-badge-danger',
	info: 'sv-ui-badge-info'
};

export function Badge({ children, className, variant = 'neutral', ...props }: BadgeProps) {
	return (
		<span className={cx('sv-ui-badge', variantClass[variant], className)} {...props}>
			{children}
		</span>
	);
}
