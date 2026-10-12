import type {
  EditableTextElement,
  EditableTextRun,
  EditableTextStyle
} from './editable-presentation'
import { normalizeTextParagraphs, resolveParagraphListNumbers } from './presentation-rich-text'
import { DRAWINGML_NS, PRESENTATIONML_NS, PptxExportError } from './pptx-export-drawingml'

export function drawingChild(parent: Element, name: string): Element | undefined {
  return Array.from(parent.children).find(
    (child) => child.namespaceURI === DRAWINGML_NS && child.localName === name
  )
}
export function presentationChild(parent: Element, name: string): Element | undefined {
  return Array.from(parent.children).find(
    (child) => child.namespaceURI === PRESENTATIONML_NS && child.localName === name
  )
}

export function replaceDrawingChild(
  parent: Element,
  generated: Element,
  name: string,
  order: readonly string[]
): void {
  const old = drawingChild(parent, name)
  const next = drawingChild(generated, name)
  if (!next) {
    old?.remove()
    return
  }
  const replacement = parent.ownerDocument.importNode(next, true)
  if (old) {
    for (const attribute of old.attributes) {
      if (attribute.namespaceURI && attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
        replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
    }
    for (const child of old.children) {
      if (child.namespaceURI !== DRAWINGML_NS || child.localName === 'extLst')
        replacement.appendChild(parent.ownerDocument.importNode(child, true))
    }
    old.replaceWith(replacement)
  } else {
    const index = order.indexOf(name)
    const following = Array.from(parent.children).find(
      (child) => child.namespaceURI === DRAWINGML_NS && order.indexOf(child.localName) > index
    )
    parent.insertBefore(replacement, following ?? null)
  }
}

function copyAttribute(target: Element, generated: Element, name: string): void {
  const value = generated.getAttribute(name)
  if (value === null) target.removeAttribute(name)
  else target.setAttribute(name, value)
}
const RUN_ORDER = [
  'ln',
  'noFill',
  'solidFill',
  'gradFill',
  'blipFill',
  'pattFill',
  'grpFill',
  'effectLst',
  'effectDag',
  'highlight',
  'uLnTx',
  'uLn',
  'uFillTx',
  'uFill',
  'latin',
  'ea',
  'cs',
  'sym',
  'hlinkClick',
  'hlinkMouseOver',
  'extLst'
]
const PARA_ORDER = [
  'lnSpc',
  'spcBef',
  'spcAft',
  'buClrTx',
  'buClr',
  'buSzTx',
  'buSzPct',
  'buSzPts',
  'buFontTx',
  'buFont',
  'buNone',
  'buAutoNum',
  'buChar',
  'buBlip',
  'tabLst',
  'defRPr',
  'extLst'
]

function patchRunProperties(
  target: Element,
  generated: Element,
  before: EditableTextRun | EditableTextStyle,
  after: EditableTextRun | EditableTextStyle,
  opacityChanged: boolean
): void {
  const fields = {
    fontSize: 'sz',
    bold: 'b',
    italic: 'i',
    underline: 'u',
    strikethrough: 'strike',
    baseline: 'baseline',
    characterSpacing: 'spc'
  } as const
  for (const [field, attribute] of Object.entries(fields)) {
    const key = field as keyof typeof fields
    if (
      (before[key] ?? (key === 'baseline' ? 'normal' : 0)) !==
      (after[key] ?? (key === 'baseline' ? 'normal' : 0))
    )
      copyAttribute(target, generated, attribute)
  }
  if (before.color !== after.color || opacityChanged) {
    for (const name of ['noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
      drawingChild(target, name)?.remove()
    replaceDrawingChild(target, generated, 'solidFill', RUN_ORDER)
  }
  if (before.highlightColor !== after.highlightColor || opacityChanged)
    replaceDrawingChild(target, generated, 'highlight', RUN_ORDER)
  if (before.fontFamily !== after.fontFamily) {
    for (const name of ['latin', 'ea', 'cs']) {
      const existing = drawingChild(target, name)
      const next = drawingChild(generated, name)
      if (existing && next) copyAttribute(existing, next, 'typeface')
      else replaceDrawingChild(target, generated, name, RUN_ORDER)
    }
    if (generated.hasAttribute('lang')) copyAttribute(target, generated, 'lang')
  }
}

export function patchSourceText(
  source: Element,
  generated: Element,
  before: EditableTextElement,
  after: EditableTextElement,
  slideId: string
): void {
  const originalBody = presentationChild(source, 'txBody')
  const generatedBody = presentationChild(generated, 'txBody')!
  if (!originalBody) {
    source.appendChild(source.ownerDocument.importNode(generatedBody, true))
    return
  }
  const beforeParagraphs = normalizeTextParagraphs(before)
  const afterParagraphs = normalizeTextParagraphs(after)
  const beforeNumbers = resolveParagraphListNumbers(beforeParagraphs)
  const afterNumbers = resolveParagraphListNumbers(afterParagraphs)
  const textChanged =
    JSON.stringify(beforeParagraphs.map((paragraph) => paragraph.runs.map((run) => run.text))) !==
    JSON.stringify(afterParagraphs.map((paragraph) => paragraph.runs.map((run) => run.text)))
  if (
    textChanged &&
    ['fld', 'hlinkClick', 'hlinkMouseOver'].some(
      (name) => originalBody.getElementsByTagNameNS(DRAWINGML_NS, name).length
    )
  ) {
    throw new PptxExportError([
      {
        code: 'source-conflict',
        message: 'Editing this text would change a retained field or hyperlink',
        slideId,
        elementId: after.id
      }
    ])
  }
  const bodyProperties = drawingChild(originalBody, 'bodyPr')
  const nextBodyProperties = drawingChild(generatedBody, 'bodyPr')!
  if (bodyProperties) {
    if (before.autoWidth !== after.autoWidth)
      copyAttribute(bodyProperties, nextBodyProperties, 'wrap')
    if (before.verticalAlign !== after.verticalAlign)
      copyAttribute(bodyProperties, nextBodyProperties, 'anchor')
    for (const [field, attribute] of [
      ['left', 'lIns'],
      ['right', 'rIns'],
      ['top', 'tIns'],
      ['bottom', 'bIns']
    ] as const) {
      if (before.textInsets?.[field] !== after.textInsets?.[field])
        copyAttribute(bodyProperties, nextBodyProperties, attribute)
    }
    if (before.autoSize !== after.autoSize) {
      for (const name of ['noAutofit', 'normAutofit', 'spAutoFit'])
        replaceDrawingChild(bodyProperties, nextBodyProperties, name, [
          'prstTxWarp',
          'noAutofit',
          'normAutofit',
          'spAutoFit',
          'scene3d',
          'sp3d',
          'flatTx',
          'extLst'
        ])
    }
  } else if (
    before.autoWidth !== after.autoWidth ||
    before.verticalAlign !== after.verticalAlign ||
    before.autoSize !== after.autoSize ||
    JSON.stringify(before.textInsets) !== JSON.stringify(after.textInsets)
  ) {
    originalBody.insertBefore(
      source.ownerDocument.importNode(nextBodyProperties, true),
      originalBody.firstChild
    )
  }
  const originalParagraphs = Array.from(originalBody.children).filter(
    (node) => node.namespaceURI === DRAWINGML_NS && node.localName === 'p'
  )
  const generatedParagraphs = Array.from(generatedBody.children).filter(
    (node) => node.namespaceURI === DRAWINGML_NS && node.localName === 'p'
  )
  const replacements: Element[] = []
  for (const [index, paragraph] of afterParagraphs.entries()) {
    const baseline = beforeParagraphs[index] ?? beforeParagraphs[0]
    const original = originalParagraphs[index] ?? originalParagraphs[0]
    const next = generatedParagraphs[index]
    if (!baseline || !original) {
      replacements.push(source.ownerDocument.importNode(next, true))
      continue
    }
    const target = original.cloneNode(true) as Element
    let properties = drawingChild(target, 'pPr')
    const nextProperties = drawingChild(next, 'pPr')!
    if (!properties) {
      properties = source.ownerDocument.createElementNS(DRAWINGML_NS, 'a:pPr')
      target.insertBefore(properties, target.firstChild)
    }
    for (const [field, attribute] of [
      ['align', 'algn'],
      ['marginLeft', 'marL'],
      ['textIndent', 'indent']
    ] as const) {
      if (baseline[field] !== paragraph[field]) copyAttribute(properties, nextProperties, attribute)
    }
    if (JSON.stringify(baseline.lineSpacing) !== JSON.stringify(paragraph.lineSpacing))
      replaceDrawingChild(properties, nextProperties, 'lnSpc', PARA_ORDER)
    const oldList = baseline.list
      ? { ...baseline.list, sequenceId: undefined, startAt: beforeNumbers[index] }
      : null
    const newList = paragraph.list
      ? { ...paragraph.list, sequenceId: undefined, startAt: afterNumbers[index] }
      : null
    if (JSON.stringify(oldList) !== JSON.stringify(newList)) {
      copyAttribute(properties, nextProperties, 'lvl')
      for (const name of ['buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip'])
        replaceDrawingChild(properties, nextProperties, name, PARA_ORDER)
    }
    const oldRuns = Array.from(target.children).filter(
      (node) => node.namespaceURI === DRAWINGML_NS && ['r', 'br', 'fld'].includes(node.localName)
    )
    const nextRuns = Array.from(next.children).filter(
      (node) => node.namespaceURI === DRAWINGML_NS && node.localName === 'r'
    )
    const runsChanged =
      JSON.stringify(baseline.runs) !== JSON.stringify(paragraph.runs) ||
      before.opacity !== after.opacity
    if (runsChanged && oldRuns.length !== baseline.runs.length) {
      throw new PptxExportError([
        {
          code: 'source-conflict',
          message: 'The retained run boundaries cannot be reconciled safely',
          slideId,
          elementId: after.id
        }
      ])
    }
    const runs: Element[] = []
    for (const [runIndex, run] of (runsChanged ? paragraph.runs : []).entries()) {
      const oldRun = oldRuns[runIndex] ?? oldRuns[0]
      const oldStyle = baseline.runs[runIndex] ?? baseline.runs[0]
      const nextRun = nextRuns[runIndex]
      if (!oldRun || !oldStyle || !['r', 'fld'].includes(oldRun.localName)) {
        runs.push(source.ownerDocument.importNode(nextRun, true))
        continue
      }
      const clone = oldRun.cloneNode(true) as Element
      let properties = drawingChild(clone, 'rPr')
      const nextProperties = drawingChild(nextRun, 'rPr')!
      if (!properties) {
        properties = source.ownerDocument.createElementNS(DRAWINGML_NS, 'a:rPr')
        clone.insertBefore(properties, clone.firstChild)
      }
      patchRunProperties(
        properties,
        nextProperties,
        oldStyle,
        run,
        before.opacity !== after.opacity
      )
      const content = drawingChild(clone, 't')
      if (content && content.textContent !== run.text) {
        content.textContent = run.text
        content.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
      } else clone.appendChild(source.ownerDocument.importNode(drawingChild(nextRun, 't')!, true))
      runs.push(clone)
    }
    if (runsChanged) for (const node of oldRuns) node.remove()
    const end = drawingChild(target, 'endParaRPr')
    const nextEnd = drawingChild(next, 'endParaRPr')
    for (const run of runs) target.insertBefore(run, end ?? drawingChild(target, 'extLst') ?? null)
    if (paragraph.typingStyle && baseline.typingStyle && end && nextEnd)
      patchRunProperties(
        end,
        nextEnd,
        baseline.typingStyle,
        paragraph.typingStyle,
        before.opacity !== after.opacity
      )
    else if (paragraph.typingStyle && !end && nextEnd)
      target.appendChild(source.ownerDocument.importNode(nextEnd, true))
    replacements.push(target)
  }
  const insertion = originalParagraphs[0] ?? null
  for (const paragraph of replacements) originalBody.insertBefore(paragraph, insertion)
  for (const paragraph of originalParagraphs) paragraph.remove()
}
