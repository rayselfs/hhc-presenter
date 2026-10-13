import type { ShapeNodeData, ThemeData } from '@aiden0z/pptx-renderer'
import { PptxCompatibilityError } from './pptx-compatibility'

type XmlNode = ShapeNodeData['source']
interface Color {
  rgb: number[]
  alpha: number
}

function unsupported(): never {
  throw new PptxCompatibilityError({ code: 'shape' }, 'Unsupported PowerPoint inherited theme fill')
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value))

// Reference: DeckCraft v0.5.0 model/resolve.rs and color/lib.rs (MIT; THIRD_PARTY_NOTICES).
export function resolvePptxShapeThemeFill(
  node: ShapeNodeData,
  theme?: ThemeData
): string | undefined {
  const properties = node.source.child('spPr')
  if (
    ['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'].some((name) =>
      properties.child(name).exists()
    )
  )
    return undefined
  const reference = node.source.child('style').child('fillRef')
  if (!reference.exists()) return undefined
  const rawIndex = reference.attr('idx') ?? ''
  if (!/^\d+$/.test(rawIndex)) return unsupported()
  const index = Number(rawIndex)
  if (index === 0) return 'transparent'
  const styles = index >= 1001 ? theme?.bgFillStyles : theme?.fillStyles
  const fill = styles?.[index - (index >= 1001 ? 1001 : 1)]
  if (!Number.isSafeInteger(index) || !fill) return unsupported()
  if (fill.localName === 'noFill') return 'transparent'
  if (fill.localName !== 'solidFill') return unsupported()
  const color = resolveColor(fill, theme, reference)
  const channels = color.rgb.map((value) => Math.round(clamp(value) * 255 + 1e-9))
  if (color.alpha < 1) return `rgba(${channels.join(', ')}, ${color.alpha})`
  return (
    '#' +
    channels
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

function resolveColor(container: XmlNode, theme?: ThemeData, reference?: XmlNode): Color {
  const children = container.children()
  if (children.length !== 1) return unsupported()
  const node = children[0]
  let color: Color
  const slot = node.attr('val')
  if (node.localName === 'schemeClr' && slot === 'phClr') {
    if (!reference) return unsupported()
    color = resolveColor(reference, theme)
  } else {
    const raw =
      node.localName === 'srgbClr'
        ? slot
        : node.localName === 'schemeClr'
          ? theme?.colorScheme.get(slot ?? '')
          : node.localName === 'sysClr'
            ? node.attr('lastClr')
            : undefined
    const hex = raw?.replace(/^#/, '')
    if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return unsupported()
    color = {
      rgb: [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255),
      alpha: 1
    }
  }
  for (const transform of node.children()) {
    const raw = transform.attr('val') ?? ''
    const value = Number(raw)
    if (
      !/^-?\d+$/.test(raw) ||
      !Number.isInteger(value) ||
      value < -2147483648 ||
      value > 2147483647
    )
      return unsupported()
    const name = transform.localName
    const amount = value / 100000
    if (['tint', 'shade', 'alpha'].includes(name) && (amount < 0 || amount > 1))
      return unsupported()
    if (['lumMod', 'alphaMod'].includes(name) && amount < 0) return unsupported()
    if (name === 'alpha') color.alpha = amount
    else if (name === 'alphaMod') color.alpha = clamp(color.alpha * amount)
    else if (name === 'alphaOff') color.alpha = clamp(color.alpha + amount)
    else if (name === 'tint' || name === 'shade') {
      color.rgb = color.rgb.map((channel) => {
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        const adjusted = clamp(linear * amount + (name === 'tint' ? 1 - amount : 0))
        return adjusted <= 0.0031308 ? adjusted * 12.92 : 1.055 * adjusted ** (1 / 2.4) - 0.055
      })
    } else if (name === 'lumMod' || name === 'lumOff') {
      const minimum = Math.min(...color.rgb)
      const maximum = Math.max(...color.rgb)
      const delta = maximum - minimum
      const luminance = (minimum + maximum) / 2
      const next = clamp(name === 'lumMod' ? luminance * amount : luminance + amount)
      const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * luminance - 1))
      const chroma = (1 - Math.abs(2 * next - 1)) * saturation
      color.rgb = color.rgb.map((channel) =>
        delta === 0 ? next : ((channel - minimum) / delta) * chroma + next - chroma / 2
      )
    } else return unsupported()
  }
  return color
}
