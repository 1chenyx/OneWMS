import { useEffect, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import { useNextNumber } from '../api/hooks';

/** 去掉空白。空串当成没填，交给服务端按规则生成。 */
export function filledCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

/**
 * 新建表单的编号框。place 为空（弹窗关着或正在编辑）时不请求。
 * 只在格子还空着、或仍是上一次建议时填入。用户改过的不覆盖。
 * 调用要写在表单 reset 的 effect 之后，同一次打开才是先清空再填。
 */
export function useSeededField(form: FormInstance, field: string, place: string | null): void {
  const query = useNextNumber(place);
  const state = useRef<{ place: string | null; seeded: string | null }>({ place: null, seeded: null });

  useEffect(() => {
    if (!place) {
      state.current = { place: null, seeded: null };
      return;
    }
    const placeChanged = state.current.place !== place;
    const previous = state.current.seeded;
    if (placeChanged) state.current = { place, seeded: null };
    if (!placeChanged && state.current.seeded !== null) return;

    const raw = form.getFieldValue(field);
    const current = typeof raw === 'string' ? raw : '';
    const suggestion = query.data?.place === place ? query.data.value : undefined;
    const untouched = !current.trim() || current === previous;
    if (!untouched) {
      state.current = { place, seeded: current };
      return;
    }
    if (!suggestion) return;
    form.setFieldValue(field, suggestion);
    state.current = { place, seeded: suggestion };
  }, [place, query.data, form, field]);
}

/**
 * 不用 Form 的编号框（开单页、拣货、退货、补货）。
 * 位置一变就丢掉手改，再填这个位置的下一号。
 */
export function useDraftNumber(place: string | null) {
  const query = useNextNumber(place);
  const [value, setValue] = useState('');
  const [edited, setEdited] = useState(false);
  const [seen, setSeen] = useState(place);
  if (seen !== place) {
    setSeen(place);
    setValue('');
    setEdited(false);
  }
  useEffect(() => {
    if (edited || !place) return;
    const next = query.data?.place === place ? query.data.value : undefined;
    if (!next) return;
    setValue(next);
  }, [edited, place, query.data]);
  return {
    value,
    onChange: (next: string) => {
      setEdited(true);
      setValue(next);
    },
  };
}
