"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";

interface DragItemProps {
  draggable: true;
  onDragStart: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/**
 * Kéo-thả đổi thứ tự bằng HTML5 drag events — reorder NGAY khi dragover
 * (như design), không chờ drop. Drop chỉ chốt (caller bắn toast tại onDrop).
 * Index đang kéo giữ trong ref (nguồn sự thật) + state (để render).
 *
 * @param onReorder - hoán vị item from → to trong list nguồn.
 * @param onDrop - gọi khi thả để chốt thứ tự (vd toast "Đã lưu thứ tự mới").
 */
export function useDragReorder(
  onReorder: (from: number, to: number) => void,
  onDrop?: () => void,
): {
  dragIdx: number;
  getItemProps: (index: number) => DragItemProps;
} {
  const [dragIdx, setDragIdx] = useState(-1);
  const dragRef = useRef(-1);

  const setIdx = useCallback((value: number) => {
    dragRef.current = value;
    setDragIdx(value);
  }, []);

  const getItemProps = useCallback(
    (index: number): DragItemProps => ({
      draggable: true,
      onDragStart: () => setIdx(index),
      onDragOver: (e) => {
        e.preventDefault();
        const from = dragRef.current;
        if (from < 0 || from === index) return;
        setIdx(index);
        onReorder(from, index);
      },
      onDrop: () => {
        if (dragRef.current >= 0) onDrop?.();
        setIdx(-1);
      },
      // Thả ngoài list → không kẹt trạng thái kéo.
      onDragEnd: () => setIdx(-1),
    }),
    [onReorder, onDrop, setIdx],
  );

  return { dragIdx, getItemProps };
}
