"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  onResizeEnd?: () => void;
}

export function ResizeHandle({ onResize, onResizeEnd }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current;
      startXRef.current = e.clientX;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setDragging(false);
      onResizeEnd?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onResize, onResizeEnd]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`w-[6px] flex-shrink-0 cursor-col-resize flex items-center justify-center group relative
        ${dragging ? "bg-blue-100" : "hover:bg-gray-100"} transition-colors`}
    >
      <GripVertical
        className={`w-3 h-3 ${dragging ? "text-blue-500" : "text-gray-300 group-hover:text-gray-500"} transition-colors`}
      />
    </div>
  );
}
