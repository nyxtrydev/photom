import { useEffect, useState } from 'react';
import { upscaleEstimate } from '@/api/upscale';
import type { UpscaleEstimate, UpscaleParams } from '@/types/upscale';

export type EstimateState =
  | { status: 'loading' }
  | { status: 'ready'; estimate: UpscaleEstimate }
  | { status: 'invalid'; message: string };

type Answer = { key: string; state: Exclude<EstimateState, { status: 'loading' }> };

/**
 * The size, time and memory for `params`, asked from the backend (the one place that decides the
 * output size) shortly after the controls stop changing. While the answer for the current
 * settings is on its way the state is "loading".
 */
export function useUpscaleEstimate(imageId: string | null, params: UpscaleParams): EstimateState {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const key = `${imageId}|${JSON.stringify(params)}`;
  useEffect(() => {
    if (!imageId) return;
    let stale = false;
    const timer = setTimeout(() => {
      upscaleEstimate(imageId, JSON.parse(key.slice(key.indexOf('|') + 1)) as UpscaleParams)
        .then((estimate) => !stale && setAnswer({ key, state: { status: 'ready', estimate } }))
        .catch((e: { message?: string }) => {
          if (!stale)
            setAnswer({
              key,
              state: { status: 'invalid', message: e?.message ?? 'Invalid size.' },
            });
        });
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [imageId, key]);
  return answer?.key === key ? answer.state : { status: 'loading' };
}
