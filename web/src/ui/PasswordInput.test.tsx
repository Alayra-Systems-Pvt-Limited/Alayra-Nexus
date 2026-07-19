import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { PasswordInput } from './PasswordInput';
import { PasswordStrength } from './PasswordStrength';

describe('PasswordInput', () => {
  it('masks by default and reveals on the eye toggle', () => {
    render(<PasswordInput value="hunter2" placeholder="Password" />);
    const input = screen.getByPlaceholderText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    // Button relabels for the reverse action.
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.type).toBe('password');
  });

  it('forwards native input props (value, placeholder)', () => {
    render(<PasswordInput value="abc" placeholder="Choose a password" />);
    expect((screen.getByPlaceholderText('Choose a password') as HTMLInputElement).value).toBe('abc');
  });
});

describe('PasswordStrength', () => {
  it('renders nothing for an empty value', () => {
    const { container } = render(<PasswordStrength value="" />);
    expect(container.firstChild).toBeNull();
  });

  it('announces the strength label for assistive tech', () => {
    render(<PasswordStrength value="correct-horse-Battery9" />);
    expect(screen.getByRole('img', { name: /Password strength: Strong/ })).toBeInTheDocument();
  });
});
