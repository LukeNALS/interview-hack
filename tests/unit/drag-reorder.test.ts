import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { DragEvent } from "react";
import { useDragReorder } from "@/hooks/use-drag-reorder";

function fakeDragEvent(): DragEvent<HTMLElement> {
  return { preventDefault: vi.fn() } as unknown as DragEvent<HTMLElement>;
}

test("test_drag_reorder_dragover_other_row_reorders_immediately", () => {
  // Arrange
  const onReorder = vi.fn();
  const { result } = renderHook(() => useDragReorder(onReorder));

  // Act — bắt đầu kéo row 0, dragover lên row 2
  act(() => result.current.getItemProps(0).onDragStart());
  act(() => result.current.getItemProps(2).onDragOver(fakeDragEvent()));

  // Assert — reorder NGAY khi dragover, không chờ drop
  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(onReorder).toHaveBeenCalledWith(0, 2);
  expect(result.current.dragIdx).toBe(2);
});

test("test_drag_reorder_dragover_same_row_does_not_reorder", () => {
  // Arrange
  const onReorder = vi.fn();
  const { result } = renderHook(() => useDragReorder(onReorder));

  // Act
  act(() => result.current.getItemProps(1).onDragStart());
  act(() => result.current.getItemProps(1).onDragOver(fakeDragEvent()));

  // Assert
  expect(onReorder).not.toHaveBeenCalled();
  expect(result.current.dragIdx).toBe(1);
});

test("test_drag_reorder_dragover_without_dragstart_is_ignored", () => {
  // Arrange
  const onReorder = vi.fn();
  const { result } = renderHook(() => useDragReorder(onReorder));

  // Act — chưa hề dragstart
  act(() => result.current.getItemProps(3).onDragOver(fakeDragEvent()));

  // Assert
  expect(onReorder).not.toHaveBeenCalled();
  expect(result.current.dragIdx).toBe(-1);
});

test("test_drag_reorder_drop_commits_order_and_resets_drag_index", () => {
  // Arrange
  const onReorder = vi.fn();
  const onDrop = vi.fn();
  const { result } = renderHook(() => useDragReorder(onReorder, onDrop));

  // Act — kéo 0 → 1 rồi thả
  act(() => result.current.getItemProps(0).onDragStart());
  act(() => result.current.getItemProps(1).onDragOver(fakeDragEvent()));
  act(() => result.current.getItemProps(1).onDrop());

  // Assert — onDrop chốt (caller bắn toast "Đã lưu thứ tự mới"), state reset
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(result.current.dragIdx).toBe(-1);
});

test("test_drag_reorder_dragend_outside_list_resets_without_commit", () => {
  // Arrange
  const onReorder = vi.fn();
  const onDrop = vi.fn();
  const { result } = renderHook(() => useDragReorder(onReorder, onDrop));

  // Act — kéo rồi thả ngoài list (chỉ có dragend, không có drop)
  act(() => result.current.getItemProps(0).onDragStart());
  act(() => result.current.getItemProps(0).onDragEnd());

  // Assert
  expect(onDrop).not.toHaveBeenCalled();
  expect(result.current.dragIdx).toBe(-1);
});

test("test_drag_reorder_multi_dragover_chains_from_current_position", () => {
  // Arrange
  const onReorder = vi.fn();
  const { result } = renderHook(() => useDragReorder(onReorder));

  // Act — kéo row 0 lướt qua row 1 rồi row 2
  act(() => result.current.getItemProps(0).onDragStart());
  act(() => result.current.getItemProps(1).onDragOver(fakeDragEvent()));
  act(() => result.current.getItemProps(2).onDragOver(fakeDragEvent()));

  // Assert — lần 2 tính từ vị trí mới (1 → 2), không phải từ 0
  expect(onReorder).toHaveBeenNthCalledWith(1, 0, 1);
  expect(onReorder).toHaveBeenNthCalledWith(2, 1, 2);
});
