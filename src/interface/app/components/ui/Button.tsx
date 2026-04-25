import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';
import { cx } from './cx';

type ButtonVariant = 'default' | 'outline' | 'ghost';
type ButtonSize = 'sm' | 'md';

type ButtonProps = PropsWithChildren<
	ButtonHTMLAttributes<HTMLButtonElement> & {
		variant?: ButtonVariant;
		size?: ButtonSize;
	}
>;

const variantClass: Record<ButtonVariant, string> = {
	default: 'sv-ui-button-default',
	outline: 'sv-ui-button-outline',
	ghost: 'sv-ui-button-ghost'
};

const sizeClass: Record<ButtonSize, string> = {
	sm: 'sv-ui-button-sm',
	md: 'sv-ui-button-md'
};

export function Button({
	children,
	className,
	variant = 'default',
	size = 'md',
	type = 'button',
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			className={cx('sv-ui-button', variantClass[variant], sizeClass[size], className)}
			{...props}
		>
			{children}
		</button>
	);
}
