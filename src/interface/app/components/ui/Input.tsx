import type { InputHTMLAttributes } from 'react';
import { cx } from './cx';

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, type = 'text', ...props }: InputProps) {
	return <input type={type} className={cx('sv-ui-input', className)} {...props} />;
}
