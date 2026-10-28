/* Gemeinsame Navigation, Konto-Anzeige, Favicon und Handy-Symbol für alle CRTG-Seiten */
(function(){
  var base=document.currentScript.src.replace(/[^/]*$/,"");
  var items=[
    ["","Start","M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
    ["stintplan/","Stintplaner","M3 5h10v4H3zM8 11h13v4H8zM3 17h8v3H3z"],
    ["sprit/","Sprit-Rechner","M12 2.5S5 10.2 5 15a7 7 0 0 0 14 0c0-4.8-7-12.5-7-12.5z"]
  ];
  var admin=["admin/","Admin","M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"];
  var here=location.pathname.replace(/index\.html$/,"");
  if(here.slice(-1)!=="/")here+="/";
  var root=new URL(base).pathname;
  function tab(i){var on=here===root+i[0];
    return '<a href="'+base+i[0]+'"'+(on?' class="on" aria-current="page"':'')+'><svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+i[2]+'"/></svg><span>'+i[1]+'</span></a>';}
  var nav=document.createElement("nav");
  nav.className="nav";nav.setAttribute("aria-label","Hauptnavigation");
  nav.innerHTML='<a class="brand" href="'+base+'"><img src="'+base+'icon.png" alt="" width="34" height="34"><span>CRTG</span></a><div class="tabs">'+items.map(tab).join("")+'</div>';
  document.body.insertBefore(nav,document.body.firstChild);
  [["icon","image/png"],["apple-touch-icon",""]].forEach(function(r){
    var l=document.createElement("link");l.rel=r[0];l.href=base+"icon.png";if(r[1])l.type=r[1];document.head.appendChild(l);
  });
  // Zugriff nur für angemeldete Nutzer: login.html ist die einzige Ausnahme
  var isLogin=/\/login\.html$/.test(location.pathname);
  if(isLogin){document.documentElement.classList.add("ready");}
  fetch(base+"api/me",{credentials:"same-origin"}).then(function(r){
    if(r.status===401)return {anon:true};
    return r.ok?r.json():null;
  }).catch(function(){return null}).then(function(u){
    if(!u||u.anon){
      if(!isLogin){location.href=base+"login.html";return;}
      var box=document.createElement("div");box.className="acct";
      box.innerHTML='<a class="login" href="'+base+'login.html">Mit Discord anmelden</a>';
      nav.appendChild(box);
      return;
    }
    document.documentElement.classList.add("ready");
    var box=document.createElement("div");box.className="acct";
    if(u.role==="admin")nav.querySelector(".tabs").insertAdjacentHTML("beforeend",tab(admin));
    box.innerHTML=(u.steam_id?"":'<a class="login" href="'+base+'api/auth/steam">Steam verknüpfen</a>')+'<button type="button" class="login nr"></button><span class="who"></span><button type="button" class="out">Abmelden</button>';
    box.querySelector(".who").textContent=u.display_name;
    var nr=box.querySelector(".nr");
    function setNr(n){nr.textContent=n?"#"+n:"Startnummer setzen"}
    setNr(u.car_number);
    nr.onclick=function(){
      var v=prompt("Deine Startnummer (0–999):",u.car_number||"");
      if(v===null)return;
      fetch(base+"api/me",{method:"PATCH",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({car_number:v})})
        .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})
        .then(function(res){if(!res.ok)return alert(res.d.error||"Fehler");u.car_number=res.d.car_number;setNr(u.car_number)});
    };
    box.querySelector(".out").onclick=function(){
      fetch(base+"api/auth/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(){location.href=base});
    };
    nav.appendChild(box);
    if(new URLSearchParams(location.search).get("error")==="steam"){alert("Diese Steam-ID ist schon mit einem anderen Konto verknüpft.");history.replaceState(null,"",location.pathname);}
  });
})();
