import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/upscale', () => ({
  upscaleEstimate: vi.fn(),
  upscaleRun: vi.fn(),
  upscaleAccept: vi.fn(),
  upscaleDiscard: vi.fn().mockResolvedValue(undefined),
  upscaleLoupe: vi.fn(),
  upscaleRequirements: vi.fn(),
}));
vi.mock('@/app/upscaleActions', () => ({
  startUpscale: vi.fn(),
  cancelUpscale: vi.fn(),
  keepUpscale: vi.fn(),
  discardResult: vi.fn(),
  revertUpscale: vi.fn(),
}));
const modelState = vi.hoisted(() => ({ ready: false }));
vi.mock('@/hooks/useModelRequirement', () => ({
  useModelRequirement: () => ({ ready: modelState.ready }),
}));
vi.mock('@/components/ModelInstallBanner', () => ({
  ModelInstallBanner: ({ requirement }: { requirement: { models: string[] } }) => (
    <div data-testid="banner">{requirement.models.join(',')}</div>
  ),
}));

import { upscaleEstimate } from '@/api/upscale';
import {
  cancelUpscale,
  discardResult,
  keepUpscale,
  revertUpscale,
  startUpscale,
} from '@/app/upscaleActions';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUpscaleStore } from '@/stores/upscaleStore';
import type { UpscaleEstimate } from '@/types/upscale';
import { UpscalePanel } from './UpscalePanel';

const meta = {
  id: 'a',
  path: '/x/a.jpg',
  name: 'a.jpg',
  width: 800,
  height: 600,
  format: 'jpeg',
  thumbnailPath: '',
};
const est = (over: Partial<UpscaleEstimate> = {}): UpscaleEstimate => ({
  outW: 1600,
  outH: 1200,
  megapixels: 1.92,
  etaSeconds: 0.2,
  memoryMb: 54,
  warnings: [],
  ...over,
});
const pending = {
  id: 'a',
  path: '/p.png',
  width: 1600,
  height: 1200,
  scale: 2 as const,
  engine: 'standard' as const,
};

function setup({ image = true } = {}) {
  useProjectStore.getState().load({
    name: 'p',
    path: null,
    images: image ? [meta] : [],
    masks: {},
    dirty: false,
  });
  useEditorStore.setState({ states: {}, activeId: null });
  if (image) {
    useEditorStore.getState().ensureState('a', 800, 600);
    useEditorStore.getState().setActive('a');
  }
  useUpscaleStore.setState({ options: {}, runs: {} });
  return render(<UpscalePanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upscaleEstimate).mockImplementation(async (_id, p) => {
    const s = p.scale ?? 1;
    return p.target
      ? est({ outW: p.target.width, outH: p.target.height })
      : est({ outW: 800 * s, outH: 600 * s, megapixels: (800 * s * 600 * s) / 1e6 });
  });
});

describe('UpscalePanel', () => {
  it('asks for an image first', () => {
    setup({ image: false });
    expect(screen.getByText('Open an image to upscale it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Upscale' })).toBeNull();
  });

  it('shows the estimate for the chosen scale, from the backend', async () => {
    setup();
    expect(screen.getByRole('radio', { name: '2x' })).toBeChecked();
    expect(await screen.findByText(/Output 1600 x 1200 \(1\.9 MP\)/)).toBeVisible();
    await userEvent.click(screen.getByRole('radio', { name: '4x' }));
    expect(await screen.findByText(/Output 3200 x 2400 \(7\.7 MP\)/)).toBeVisible();
    expect(upscaleEstimate).toHaveBeenLastCalledWith('a', { scale: 4, engine: 'standard' });
    expect(screen.getByText(/Memory about 54 MB/)).toBeVisible();
    expect(screen.getByText(/under a second/)).toBeVisible();
  });

  it('wires the model banner to the model of the chosen scale', async () => {
    setup();
    expect(screen.queryByTestId('banner')).toBeNull(); // Standard needs no model
    await userEvent.click(screen.getByRole('radio', { name: /AI \(Real-ESRGAN\)/ }));
    expect(screen.getByTestId('banner')).toHaveTextContent('upscale-x2');
    await userEvent.click(screen.getByRole('radio', { name: '4x' }));
    expect(screen.getByTestId('banner')).toHaveTextContent('upscale-x4');
    // A custom size that needs more than 2x uses the x4 model, one that does not uses x2.
    await userEvent.click(screen.getByRole('radio', { name: 'Custom target size' }));
    expect(screen.getByTestId('banner')).toHaveTextContent('upscale-x2'); // default 2x target
    const w = screen.getByRole('textbox', { name: 'Width' });
    await userEvent.clear(w);
    await userEvent.type(w, '2400{Enter}');
    expect(screen.getByTestId('banner')).toHaveTextContent('upscale-x4');
  });

  it('keeps the proportions of a custom target, unless unlocked', async () => {
    setup();
    await userEvent.click(screen.getByRole('radio', { name: 'Custom target size' }));
    const w = screen.getByRole('textbox', { name: 'Width' });
    const h = screen.getByRole('textbox', { name: 'Height' });
    await userEvent.clear(w);
    await userEvent.type(w, '2000{Enter}');
    expect(h).toHaveValue('1500');
    await userEvent.click(screen.getByRole('button', { name: 'Keep the proportions' }));
    await userEvent.clear(h);
    await userEvent.type(h, '1000{Enter}');
    expect(w).toHaveValue('2000');
    expect(await screen.findByText(/Output 2000 x 1000/)).toBeVisible();
    expect(upscaleEstimate).toHaveBeenLastCalledWith('a', {
      target: { width: 2000, height: 1000 },
      engine: 'standard',
    });
  });

  it('Reduce artefacts is off by default and is sent to the backend when ticked', async () => {
    setup();
    const box = screen.getByRole('checkbox', { name: 'Reduce artefacts' });
    expect(box).not.toBeChecked();
    expect(await screen.findByText(/Output 1600 x 1200/)).toBeVisible();
    await userEvent.click(box);
    expect(box).toBeChecked();
    await waitFor(() =>
      expect(upscaleEstimate).toHaveBeenLastCalledWith('a', {
        scale: 2,
        engine: 'standard',
        preDenoise: true,
      }),
    );
  });

  it('AI can be chosen, and Upscale waits for its model', async () => {
    setup();
    expect(screen.getByRole('radio', { name: /Standard \(no AI\)/ })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /AI \(Real-ESRGAN\)/ }));
    expect(await screen.findByText(/Output 1600 x 1200/)).toBeVisible();
    expect(upscaleEstimate).toHaveBeenLastCalledWith('a', { scale: 2, engine: 'ai' });
    expect(screen.getByRole('button', { name: 'Upscale' })).toBeDisabled();
    modelState.ready = true;
    await userEvent.click(screen.getByRole('radio', { name: /Standard \(no AI\)/ }));
    await userEvent.click(screen.getByRole('radio', { name: /AI \(Real-ESRGAN\)/ }));
    expect(await screen.findByRole('button', { name: 'Upscale' })).toBeEnabled();
    modelState.ready = false;
  });

  it('an invalid size is explained and blocks Upscale', async () => {
    vi.mocked(upscaleEstimate).mockRejectedValue({
      message: 'The target size must be larger than the image.',
    });
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('must be larger');
    expect(screen.getByRole('button', { name: 'Upscale' })).toBeDisabled();
  });

  it('a blocking warning disables Upscale; a plain notice only changes its label', async () => {
    vi.mocked(upscaleEstimate).mockResolvedValue(
      est({
        warnings: [
          {
            code: 'too-large',
            message: 'The result would be 192.0 MP; the limit is 100 MP.',
            blocking: true,
          },
        ],
      }),
    );
    const { unmount } = setup();
    expect(await screen.findByText(/limit is 100 MP/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upscale' })).toBeDisabled();
    unmount();

    vi.mocked(upscaleEstimate).mockResolvedValue(
      est({
        warnings: [
          {
            code: 'already-large',
            message: 'This image is already high resolution. Upscale anyway?',
            blocking: false,
          },
        ],
      }),
    );
    setup();
    expect(await screen.findByText(/already high resolution/)).toBeVisible();
    const btn = screen.getByRole('button', { name: 'Upscale anyway' });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(startUpscale).toHaveBeenCalledWith('a');
  });

  it('Upscale starts the job once the estimate is in', async () => {
    setup();
    const btn = screen.getByRole('button', { name: 'Upscale' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    expect(startUpscale).toHaveBeenCalledWith('a');
  });

  it('while running it shows progress with Cancel and locks the options', async () => {
    setup();
    useUpscaleStore.getState().setRun('a', { phase: 'running', jobId: 'j' });
    expect(await screen.findByText('Upscaling...')).toBeVisible();
    expect(screen.getByRole('radio', { name: '4x' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelUpscale).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('button', { name: 'Upscale' })).toBeNull();
  });

  it('review offers Keep and Discard', async () => {
    setup();
    useUpscaleStore.getState().setRun('a', { phase: 'review', pending });
    await userEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(keepUpscale).toHaveBeenCalledWith('a');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(discardResult).toHaveBeenCalledWith('a');
  });

  it('an error is announced and Try again re-runs', async () => {
    setup();
    useUpscaleStore
      .getState()
      .setRun('a', { phase: 'error', message: 'The image could not be decoded.' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Upscaling failed');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be decoded');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(startUpscale).toHaveBeenCalled();
  });

  it('shows the kept version and can go back to the original', async () => {
    setup();
    useEditorStore.getState().setUpscale('a', {
      path: '/k.png',
      width: 3200,
      height: 2400,
      scale: 4,
      engine: 'standard',
    });
    const box = await screen.findByRole('region', { name: 'Upscaled version kept' });
    expect(within(box).getByText('3200 x 2400 · 4x, Standard')).toBeVisible();
    await userEvent.click(within(box).getByRole('button', { name: 'Back to the original' }));
    expect(revertUpscale).toHaveBeenCalledWith('a');
  });

  it('describes a custom-size kept version honestly', async () => {
    setup();
    useEditorStore.getState().setUpscale('a', {
      path: '/k.png',
      width: 1000,
      height: 750,
      scale: null,
      engine: 'standard',
    });
    expect(await screen.findByText('1000 x 750 · custom size, Standard')).toBeVisible();
  });

  it('carries the honesty note about what upscaling can and cannot do', () => {
    setup();
    expect(screen.getByText(/cannot recover real detail/)).toBeVisible();
  });
});
