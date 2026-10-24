export function Loading() {
  return (
    <div className="grid min-h-[70vh] place-items-center" role="status" aria-label="Загрузка">
      <span className="block h-[3px] w-24 animate-pulse bg-brand" />
    </div>
  )
}
