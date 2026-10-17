import React from 'react'

const ButtonMock = ({
  children,
  onPress,
  isDisabled,
  isIconOnly: _isIconOnly,
  ...props
}: {
  children?: React.ReactNode
  onPress?: () => void
  isDisabled?: boolean
  isIconOnly?: boolean
  [key: string]: unknown
}): React.JSX.Element => (
  <button
    disabled={isDisabled}
    onClick={onPress}
    {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
  >
    {children}
  </button>
)

const ButtonGroupMock = Object.assign(
  ({ children }: { children?: React.ReactNode }): React.JSX.Element => <div>{children}</div>,
  {
    Separator: ({ className }: { className?: string }): React.JSX.Element => (
      <span className={className} />
    )
  }
)

type TabsMockProps = {
  children: React.ReactNode
  selectedKey?: string
  defaultSelectedKey?: string
  onSelectionChange?: (key: string) => void
}

const TabsMockContext = React.createContext<{
  selectedKey?: string
  select: (key: string) => void
}>({ select: () => {} })

function TabsRootMock({
  children,
  selectedKey,
  defaultSelectedKey,
  onSelectionChange
}: TabsMockProps): React.JSX.Element {
  const [uncontrolledKey, setUncontrolledKey] = React.useState(defaultSelectedKey)
  return (
    <TabsMockContext.Provider
      value={{
        selectedKey: selectedKey ?? uncontrolledKey,
        select: (key) => {
          if (selectedKey === undefined) setUncontrolledKey(key)
          onSelectionChange?.(key)
        }
      }}
    >
      <div role="tablist">{children}</div>
    </TabsMockContext.Provider>
  )
}

const TabsMock = Object.assign(TabsRootMock, {
  Root: TabsRootMock,
  ListContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tab: ({
    children,
    id,
    'data-testid': dataTestId,
    ...rest
  }: {
    children: React.ReactNode
    id?: string
    'data-testid'?: string
    [key: string]: unknown
  }) => {
    const tabs = React.useContext(TabsMockContext)
    return (
      <button
        role="tab"
        aria-selected={tabs.selectedKey === id}
        data-testid={dataTestId}
        onClick={() => id && tabs.select(id)}
        {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {children}
      </button>
    )
  },
  Indicator: () => null,
  Panel: ({ children, id }: { children: React.ReactNode; id?: string }) => {
    const tabs = React.useContext(TabsMockContext)
    return id === undefined || tabs.selectedKey === id ? (
      <div role="tabpanel">{children}</div>
    ) : null
  },
  Separator: () => null
})

const ModalMock = Object.assign(
  ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  {
    Root: ({ state, children }: { state?: { isOpen: boolean }; children: React.ReactNode }) =>
      state?.isOpen ? <div>{children}</div> : null,
    Trigger: () => null,
    Backdrop: ({
      children,
      isOpen = true,
      onOpenChange
    }: {
      children: React.ReactNode
      isOpen?: boolean
      onOpenChange?: (isOpen: boolean) => void
    }) =>
      isOpen ? (
        <div onKeyDown={(event) => event.key === 'Escape' && onOpenChange?.(false)}>{children}</div>
      ) : null,
    Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Dialog: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <div role="dialog" {...(props as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    ),
    Header: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Heading: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Icon: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Body: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Footer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CloseTrigger: () => null
  }
)

const PopoverMock = Object.assign(
  ({
    children,
    isOpen,
    onOpenChange
  }: {
    children: React.ReactNode
    isOpen?: boolean
    onOpenChange?: (open: boolean) => void
  }) => (
    <div
      onClickCapture={(event) => {
        if (
          isOpen !== undefined &&
          event.target instanceof Element &&
          event.target.closest('button') === event.currentTarget.querySelector('button')
        )
          onOpenChange?.(!isOpen)
      }}
    >
      {children}
    </div>
  ),
  {
    Trigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Arrow: () => null,
    Heading: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  }
)

function useOverlayStateMock(args?: { isOpen?: boolean; onOpenChange?: (open: boolean) => void }): {
  isOpen: boolean
  setOpen: (v: boolean) => void
  open: () => void
  close: () => void
  toggle: () => void
} {
  const [isOpen, setIsOpen] = React.useState(args?.isOpen ?? false)
  return {
    isOpen,
    setOpen: (v: boolean) => {
      setIsOpen(v)
      args?.onOpenChange?.(v)
    },
    open: () => {
      setIsOpen(true)
      args?.onOpenChange?.(true)
    },
    close: () => {
      setIsOpen(false)
      args?.onOpenChange?.(false)
    },
    toggle: () => {
      setIsOpen((prev) => {
        args?.onOpenChange?.(!prev)
        return !prev
      })
    }
  }
}

const AvatarMock = Object.assign(
  ({
    children,
    className,
    ...props
  }: {
    children?: React.ReactNode
    className?: string
    [key: string]: unknown
  }) => (
    <div
      data-slot="avatar"
      className={className}
      {...(props as React.HTMLAttributes<HTMLDivElement>)}
    >
      {children}
    </div>
  ),
  {
    Root: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <div
        data-slot="avatar"
        className={className}
        {...(props as React.HTMLAttributes<HTMLDivElement>)}
      >
        {children}
      </div>
    ),
    Image: ({
      className,
      src,
      alt,
      ...props
    }: {
      className?: string
      src?: string
      alt?: string
      [key: string]: unknown
    }) => (
      <img
        src={src}
        alt={alt}
        className={className}
        {...(props as React.ImgHTMLAttributes<HTMLImageElement>)}
      />
    ),
    Fallback: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <span
        data-slot="avatar-fallback"
        className={className}
        {...(props as React.HTMLAttributes<HTMLSpanElement>)}
      >
        {children}
      </span>
    )
  }
)

let capturedDropdownMenuOnAction: ((key: React.Key) => void) | undefined

const DropdownMock = Object.assign(
  ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
  ),
  {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
    ),
    Trigger: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <div className={className} {...(props as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    ),
    Popover: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <div className={className} {...(props as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    ),
    Menu: ({
      children,
      onAction,
      ...props
    }: {
      children?: React.ReactNode
      onAction?: (key: React.Key) => void
      [key: string]: unknown
    }) => {
      capturedDropdownMenuOnAction = onAction
      return (
        <ul role="menu" {...(props as React.HTMLAttributes<HTMLUListElement>)}>
          {children}
        </ul>
      )
    },
    Section: ({
      children,
      title,
      ...props
    }: {
      children?: React.ReactNode
      title?: React.ReactNode
      [key: string]: unknown
    }) => (
      <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>
        {title && <div>{title}</div>}
        {children}
      </div>
    ),
    Item: ({
      children,
      onAction,
      isDisabled,
      id,
      ...props
    }: {
      children?: React.ReactNode
      onAction?: (key: React.Key) => void
      isDisabled?: boolean
      id?: string
      [key: string]: unknown
    }) => (
      <li
        role="menuitem"
        aria-disabled={isDisabled}
        onClick={() => {
          if (!isDisabled) {
            const handler = onAction || capturedDropdownMenuOnAction
            if (handler && id) {
              handler(id)
            }
          }
        }}
        {...(props as React.LiHTMLAttributes<HTMLLIElement>)}
      >
        {children}
      </li>
    ),
    ItemIndicator: ({
      children,
      ...props
    }: {
      children?: React.ReactNode
      [key: string]: unknown
    }) => <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>,
    SubmenuIndicator: ({
      children,
      ...props
    }: {
      children?: React.ReactNode
      [key: string]: unknown
    }) => <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>,
    SubmenuTrigger: ({
      children,
      ...props
    }: {
      children?: React.ReactNode
      [key: string]: unknown
    }) => <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
  }
)

const SelectContext = React.createContext<{
  onChange?: (key: React.Key) => void
}>({})

const SelectMock = Object.assign(
  ({
    children,
    className,
    value: _v1,
    onChange,
    selectedKey: _sk1,
    onSelectionChange,
    isDisabled,
    ...props
  }: {
    children?: React.ReactNode
    className?: string
    value?: React.Key
    onChange?: (key: React.Key) => void
    selectedKey?: React.Key
    onSelectionChange?: (key: React.Key) => void
    isDisabled?: boolean
    [key: string]: unknown
  }) => (
    <SelectContext value={{ onChange: onChange ?? onSelectionChange }}>
      <div
        className={className}
        data-testid="select-root"
        aria-disabled={isDisabled}
        {...(props as React.HTMLAttributes<HTMLDivElement>)}
      >
        {children}
      </div>
    </SelectContext>
  ),
  {
    Root: ({
      children,
      className,
      value: _v2,
      onChange,
      selectedKey: _sk2,
      onSelectionChange,
      isDisabled,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      value?: React.Key
      onChange?: (key: React.Key) => void
      selectedKey?: React.Key
      onSelectionChange?: (key: React.Key) => void
      isDisabled?: boolean
      [key: string]: unknown
    }) => (
      <SelectContext value={{ onChange: onChange ?? onSelectionChange }}>
        <div
          className={className}
          data-testid="select-root"
          aria-disabled={isDisabled}
          {...(props as React.HTMLAttributes<HTMLDivElement>)}
        >
          {children}
        </div>
      </SelectContext>
    ),
    Trigger: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <button className={className} {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
        {children}
      </button>
    ),
    Value: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <span className={className} {...(props as React.HTMLAttributes<HTMLSpanElement>)}>
        {children}
      </span>
    ),
    Indicator: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <div className={className} {...(props as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    ),
    Popover: ({
      children,
      className,
      ...props
    }: {
      children?: React.ReactNode
      className?: string
      [key: string]: unknown
    }) => (
      <div className={className} {...(props as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    )
  }
)

let capturedListboxOnSelectionChange: ((keys: Set<React.Key>) => void) | undefined
let capturedListboxSelectedKeys: Set<React.Key> | undefined

const ListboxMock = Object.assign(
  ({
    children,
    selectedKeys,
    onSelectionChange,
    ...props
  }: {
    children?: React.ReactNode
    selectedKeys?: Set<React.Key>
    onSelectionChange?: (keys: Set<React.Key>) => void
    [key: string]: unknown
  }) => {
    capturedListboxOnSelectionChange = onSelectionChange
    capturedListboxSelectedKeys = selectedKeys
    return (
      <ul role="listbox" {...(props as React.HTMLAttributes<HTMLUListElement>)}>
        {children}
      </ul>
    )
  },
  {
    Root: ({
      children,
      selectedKeys,
      onSelectionChange,
      ...props
    }: {
      children?: React.ReactNode
      selectedKeys?: Set<React.Key>
      onSelectionChange?: (keys: Set<React.Key>) => void
      [key: string]: unknown
    }) => {
      capturedListboxOnSelectionChange = onSelectionChange
      capturedListboxSelectedKeys = selectedKeys
      return (
        <ul role="listbox" {...(props as React.HTMLAttributes<HTMLUListElement>)}>
          {children}
        </ul>
      )
    },
    Item: ({
      children,
      id,
      isDisabled,
      textValue: _textValue,
      ...props
    }: {
      children?: React.ReactNode
      id?: string
      isDisabled?: boolean
      textValue?: string
      [key: string]: unknown
    }) => {
      const selectCtx = React.useContext(SelectContext)
      return (
        <li
          role="option"
          aria-disabled={isDisabled}
          aria-selected={id ? capturedListboxSelectedKeys?.has(id) : false}
          onClick={() => {
            if (isDisabled) return
            if (id && capturedListboxOnSelectionChange) {
              capturedListboxOnSelectionChange(new Set([id]))
            }
            if (id && selectCtx.onChange) {
              selectCtx.onChange(id)
            }
          }}
          {...(props as React.LiHTMLAttributes<HTMLLIElement>)}
        >
          {children}
        </li>
      )
    }
  }
)

const AlertDialogMock = Object.assign(
  ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  {
    Backdrop: ({
      isOpen,
      children
    }: {
      isOpen?: boolean
      onOpenChange?: (open: boolean) => void
      children?: React.ReactNode
    }) => (isOpen ? <div>{children}</div> : null),
    Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Header: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Heading: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Icon: (_props: { status?: string }) => null,
    Body: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Footer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  }
)

export {
  ButtonMock,
  ButtonGroupMock,
  TabsMock,
  ModalMock,
  PopoverMock,
  useOverlayStateMock,
  AvatarMock,
  DropdownMock,
  SelectMock,
  ListboxMock,
  AlertDialogMock
}
