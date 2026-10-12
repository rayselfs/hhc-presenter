import type { EditableShapeKind } from './editable-presentation'

interface PresetShapeDescriptor {
  preset: string
  guides: readonly string[]
  defaults: readonly number[]
}

// Preset defaults adapted from DeckCraft v0.5.0 crates/geom/src/preset.rs (MIT).
const PRESET_SHAPES: Record<EditableShapeKind, PresetShapeDescriptor> = {
  rectangle: { preset: 'rect', guides: [], defaults: [] },
  ellipse: { preset: 'ellipse', guides: [], defaults: [] },
  roundRect: { preset: 'roundRect', guides: ['adj'], defaults: [16667] },
  triangle: { preset: 'triangle', guides: ['adj'], defaults: [50000] },
  rtTriangle: { preset: 'rtTriangle', guides: [], defaults: [] },
  diamond: { preset: 'diamond', guides: [], defaults: [] },
  rightArrow: { preset: 'rightArrow', guides: ['adj1', 'adj2'], defaults: [50000, 50000] },
  leftArrow: { preset: 'leftArrow', guides: ['adj1', 'adj2'], defaults: [50000, 50000] },
  upArrow: { preset: 'upArrow', guides: ['adj1', 'adj2'], defaults: [50000, 50000] },
  downArrow: { preset: 'downArrow', guides: ['adj1', 'adj2'], defaults: [50000, 50000] }
}

export function getPresetShapeDescriptor(shape: unknown): PresetShapeDescriptor | undefined {
  return typeof shape === 'string' && Object.hasOwn(PRESET_SHAPES, shape)
    ? PRESET_SHAPES[shape as EditableShapeKind]
    : undefined
}
