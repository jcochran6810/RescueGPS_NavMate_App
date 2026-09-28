import { toDD, toDDM, toDMS } from './coords'

/** A position in the crew's coordinate format: "29° 36.610' N  94° 53.190' W". */
export function formatPlace(p: { lat: number; lon: number }, format: 'dd' | 'ddm' | 'dms'): string {
  if (format === 'dd') return `${toDD(p.lat)}, ${toDD(p.lon)}`
  if (format === 'dms') return `${toDMS(p.lat, 'lat')}  ${toDMS(p.lon, 'lon')}`
  return `${toDDM(p.lat, 'lat')}  ${toDDM(p.lon, 'lon')}`
}
