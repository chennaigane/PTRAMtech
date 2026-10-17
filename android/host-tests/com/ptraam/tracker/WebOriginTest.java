package com.ptraam.tracker;
public final class WebOriginTest {
 public static void main(String[] args){String origin="https://fieldora.test";int checks=0;
 for(String url:new String[]{origin,origin+"/dashboard",origin+"/login?next=x",origin+"/"}){checks++;if(!WebOrigin.matches(origin,url))throw new AssertionError(url);}
 for(String url:new String[]{null,"","https://fieldora.test.evil.test/","http://fieldora.test/","https://fieldora.test@evil.test/","https://evil.test@fieldora.test/","https://fieldora.test:443/","file:///dashboard","javascript:alert(1)","data:text/html,x","https://fieldora.test\\@evil.test/","https://fieldora.test%2eevil.test/","https://evil.test/"}){checks++;if(WebOrigin.matches(origin,url))throw new AssertionError(url);}
 System.out.println(checks+" origin-policy assertions passed");}
}
