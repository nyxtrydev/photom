import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useModelStore } from '@/stores/modelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';
import { App } from './App';

beforeEach(() => {
  useUiStore.setState({ screen: 'home', settingsOpen: false, notices: [] });
  useProjectStore.getState().clearImages();
  useModelStore.setState({ status: null });
});

describe('App shell', () => {
  it('renders the title bar controls and home hero', () => {
    render(<App />);
    expect(screen.getByText('Photom')).toBeInTheDocument();
    for (const name of ['Minimize', 'Maximize', 'Close']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Drag & drop images here')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Images' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Folder' })).toBeInTheDocument();
    expect(screen.getByText(/No recent projects/)).toBeInTheDocument();
  });

  it('switches theme from the settings dialog', async () => {
    render(<App />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('the model status opens Settings > Model when it needs attention', async () => {
    useModelStore.setState({
      status: {
        ready: false,
        state: 'missing',
        activeModel: 'fast',
        device: 'cpu',
        path: null,
        message: null,
      },
    });
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Model missing' }));
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'model' });
    expect(await screen.findByRole('tab', { name: 'Model', selected: true })).toBeInTheDocument();
  });

  it('shows a loading skeleton while the model loads', () => {
    useModelStore.setState({
      status: {
        ready: true,
        state: 'loading',
        activeModel: 'fast',
        device: 'cpu',
        path: null,
        message: null,
      },
    });
    const { container } = render(<App />);
    expect(screen.getByText('Loading model...')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('navigates between screens via the sidebar', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Batch Process' }));
    expect(screen.getByRole('heading', { name: 'Batch Process' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Background' }));
    expect(screen.getByRole('heading', { name: 'Remove Background' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose an image' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByText('Drag & drop images here')).toBeInTheDocument();
  });

  it.each([
    ['missing', 'Model missing'],
    ['loading', 'Loading model...'],
    ['idle', 'Model ready (offline)'],
    ['error', 'Model error'],
  ] as const)('shows model state %s in the status bar', (state, text) => {
    useModelStore.setState({
      status: {
        ready: state !== 'missing',
        state,
        activeModel: 'fast',
        device: 'cpu',
        path: null,
        message: null,
      },
    });
    render(<App />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
