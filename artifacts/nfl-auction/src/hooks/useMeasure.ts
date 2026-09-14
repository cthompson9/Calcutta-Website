import { useEffect, useRef, useState } from 'react'

export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(node)
    setSize({ width: node.clientWidth, height: node.clientHeight })
    return () => observer.disconnect()
  }, [])

  return { ref, ...size }
}
