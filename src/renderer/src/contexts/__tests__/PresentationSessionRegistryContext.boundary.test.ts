import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const registryPath = resolve(
  process.cwd(),
  'src/renderer/src/contexts/PresentationSessionRegistryContext.tsx'
)
const rendererRoot = resolve(process.cwd(), 'src/renderer/src')
const runtimePaths = [
  'editable-presentation',
  'editable-presentation-persistence',
  'presentation-editor-session'
].map((name) => resolve(rendererRoot, 'lib', name))

function eagerRuntimeImports(source: string): string[] {
  const ast = ts.createSourceFile(
    registryPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const imports: string[] = []
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.isTypeOnly) continue
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((entry) => entry.isTypeOnly)
      )
        continue
    } else {
      if (node.isTypeOnly) continue
      if (
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((entry) => entry.isTypeOnly)
      )
        continue
    }
    const specifier = node.moduleSpecifier.text
    const target = specifier.startsWith('@renderer/')
      ? resolve(rendererRoot, specifier.slice('@renderer/'.length))
      : resolve(dirname(registryPath), specifier)
    if (runtimePaths.includes(target.replace(/\.[jt]sx?$/, ''))) imports.push(specifier)
  }
  return imports
}

describe('PresentationSessionRegistryContext startup boundary', () => {
  it('does not eagerly import presentation editor runtime modules', () => {
    expect(eagerRuntimeImports(readFileSync(registryPath, 'utf8'))).toEqual([])
  })

  it.each([
    "import Default, { type Doc } from '@renderer/lib/editable-presentation'",
    "import editor from '../lib/editable-presentation.js'",
    "import * as editor from '@renderer/lib/editable-presentation'",
    "import { loadEditablePresentationSnapshot as load } from '../lib/editable-presentation'",
    "import {\n loadEditablePresentationSnapshot\n} from '@renderer/lib/editable-presentation'",
    "import '@renderer/lib/presentation-editor-session'",
    "export * from '@renderer/lib/editable-presentation-persistence'",
    "export { persist as save } from '../lib/editable-presentation-persistence.ts'",
    "import { type Doc, load } from '@renderer/lib/editable-presentation'"
  ])('rejects eager syntax: %s', (source) => {
    expect(eagerRuntimeImports(source)).toHaveLength(1)
  })

  it.each([
    "import type * as editor from '@renderer/lib/editable-presentation'",
    "import { type Doc } from '@renderer/lib/editable-presentation'",
    "export type { Doc } from '@renderer/lib/editable-presentation'",
    "export { type Doc } from '@renderer/lib/editable-presentation'",
    "const load = () => import('@renderer/lib/editable-presentation')",
    "// import editor from '@renderer/lib/editable-presentation'",
    "import { createContext } from 'react'"
  ])('allows type-only or lazy syntax: %s', (source) => {
    expect(eagerRuntimeImports(source)).toEqual([])
  })
})
