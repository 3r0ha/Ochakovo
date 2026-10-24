import photos from './photos.json'

/** Имена фото из манифеста scripts/photos.mjs — общие для сайта и ботов */
export type PhotoName = keyof typeof photos

export { photos }
