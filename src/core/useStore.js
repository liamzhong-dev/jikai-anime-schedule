import { useEffect, useState } from 'react';
import { getState, subscribe } from './store.js';

/** 把命令式 store 接到 React：状态变更时重渲染 */
export function useStoreState() {
  const [snap, setSnap] = useState(() => getState());
  useEffect(() => subscribe(() => setSnap(getState())), []);
  return snap;
}
