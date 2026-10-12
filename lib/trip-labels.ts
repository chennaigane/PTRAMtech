// Only structured area fields may become a public journey label. Never infer
// locality from a POI name, formatted address, street, postcode or legacy text.
export function localityName(address:any):string {
  for(const field of ['suburb','neighbourhood','neighborhood','locality','town','village','city','district']){
    const value=address?.[field];
    if(typeof value==='string'&&value.trim())return value.trim().slice(0,100);
  }
  return '';
}
export function tripLocationLabel(data:any,side:'start'|'end'){
  if(side==='end'&&data.status==='Travelling')return 'Travelling';
  const point=data[side+'Location']||(side==='start'?data.points?.[0]:null);
  const locality=localityName(point?.address);
  if(locality)return locality;
  if(point&&!point.address&&point.geocoding?.status!=='resolved')return 'Locality pending';
  return 'Locality unavailable';
}
