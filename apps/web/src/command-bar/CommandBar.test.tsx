import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommandBar } from './CommandBar.js';
import { useImagery } from '../state/stores.js';

describe('CommandBar imagery toggle', () => {
  beforeEach(() => {
    useImagery.getState().setMode('2d-dark');
  });

  it('is clickable WITHOUT an ion token — 3d-sat runs on the keyless stack', () => {
    render(<CommandBar viewer={null} ionToken="" />);
    const toggle = screen.getByTestId('imagery-toggle');
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(useImagery.getState().mode).toBe('3d-sat');
    fireEvent.click(toggle);
    expect(useImagery.getState().mode).toBe('2d-dark');
  });
});
