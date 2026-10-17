package com.ptraam.tracker;
/** Exact HTTPS origin policy shared by top-level navigation and port delivery. */
final class WebOrigin {
 static boolean matches(String origin,String url){try{java.net.URI u=new java.net.URI(url);return "https".equals(u.getScheme())&&u.getRawUserInfo()==null&&origin.equals(u.getScheme()+"://"+u.getRawAuthority());}catch(Exception e){return false;}}
}
