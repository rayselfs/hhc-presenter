import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabsMock as Tabs } from './heroui-mock'

describe('Tabs test double isolation', () => {
  it('keeps two controlled instances and their callbacks independent', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <>
        <Tabs selectedKey="a" onSelectionChange={first}>
          <Tabs.Tab id="a">First A</Tabs.Tab>
          <Tabs.Tab id="b">First B</Tabs.Tab>
          <Tabs.Panel id="a">First panel A</Tabs.Panel>
          <Tabs.Panel id="b">First panel B</Tabs.Panel>
        </Tabs>
        <Tabs.Root selectedKey="b" onSelectionChange={second}>
          <Tabs.Tab id="a">Second A</Tabs.Tab>
          <Tabs.Tab id="b">Second B</Tabs.Tab>
          <Tabs.Panel id="a">Second panel A</Tabs.Panel>
          <Tabs.Panel id="b">Second panel B</Tabs.Panel>
        </Tabs.Root>
      </>
    )
    expect(screen.getByRole('tab', { name: 'First A' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Second B' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'First B' }))
    expect(first).toHaveBeenCalledWith('b')
    expect(second).not.toHaveBeenCalled()
    expect(screen.queryByText('First panel B')).not.toBeInTheDocument()
    expect(screen.getByText('First panel A')).toBeInTheDocument()
    expect(screen.getByText('Second panel B')).toBeInTheDocument()
  })

  it('changes only the selected panel of an uncontrolled instance', () => {
    render(
      <Tabs defaultSelectedKey="a">
        <Tabs.Tab id="a">A</Tabs.Tab>
        <Tabs.Tab id="b">B</Tabs.Tab>
        <Tabs.Panel id="a">Panel A</Tabs.Panel>
        <Tabs.Panel id="b">Panel B</Tabs.Panel>
      </Tabs>
    )
    fireEvent.click(screen.getByRole('tab', { name: 'B' }))
    expect(screen.queryByText('Panel A')).not.toBeInTheDocument()
    expect(screen.getByText('Panel B')).toBeInTheDocument()
  })
})
