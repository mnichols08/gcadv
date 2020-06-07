//I wrote this section from scratch. go me!
var menuCategory = [
  {"name": "home"},
  {"name": "connect"}
];
var ul = document.getElementById("navMenu");
var catDesc = document.getElementById("catDesc");
var e;
for (e = 0; e < menuCategory.length; e++) {
var li = document.createElement("li");
$(li).appendTo(ul);
li.className = "nav-item " + menuCategory[e].name;
var aNchor = document.createElement("a");
$(aNchor).appendTo(li);
aNchor.id = menuCategory[e].name + "button";
aNchor.className = "nav-link";
aNchor.setAttribute('href','#'+ menuCategory[e].name);
aNchor.setAttribute('data-toggle','collapse');
aNchor.setAttribute('data-target','.navbar-collapse');
document.getElementById(menuCategory[e].name + "button").innerHTML = menuCategory[e].name;
};


$(function() {
  var nav = $("nav");
  $(window).scroll(function() {
      var scroll = $(window).scrollTop(),
      body = $(".parallax.thanks").offset().top;
    if (scroll > body - 76) {
      nav.removeClass("navbar-bottom")
        .addClass("fixed-top");
    } else {
      nav.removeClass("fixed-top").addClass("navbar-bottom");
    }
  });
});


$("#connectbutton").click(function() {
  var connectsection = $("#connect").offset().top
  $("html, body").animate(
    {
      scrollTop: connectsection - 76
    },
    2000
  );
});
$("#homebutton").click(function() {
  $("html, body").animate(
    {
      scrollTop: $("#home").offset().top + 350
    },
    2000
  );
});
$(window).resize(function() {
  var viewportWidth = $(window).width();
  if (viewportWidth < 767) {
    $(".navbar-nav")
      .removeClass("ml-auto")
      .addClass("text-right");
  }else {
      $(".navbar-nav").removeClass("text-right").addClass("ml-auto");
    }
});

var home = $(".parallax.thanks").offset().top;
var connect = $("#connect").offset().top;

$(document).ready(function() {
      $(window).scroll(function(){

        var screenPosition = $(document).scrollTop();

        if (screenPosition < home + 50) {
                $("a#homebutton").addClass("active");
                $("a#connectbutton").removeClass("active");
            } else {
              $("a#homebutton").removeClass("active");
              $("a#connectbutton").addClass("active");
            }

    });

      $(".home, .connect").click(function() {$(window).scroll();});
});
$(document).ready(function() {
  $(document).scrollTop(350);
  $(document).ready(function() {
  	$.getJSON("https://codepen.io/mnichols08/pen/ZoVZmy.js", function(quotes) {
  		var randomNumber = Math.floor(Math.random() * quotes.length);
  		currentQuote = quotes[randomNumber].quoteText;
  		currentAuthor = quotes[randomNumber].quoteAuthor;
  		document.querySelector(".well.quote .mb-0").innerHTML = '"' + currentQuote + '"';
  		document.querySelector(".well.quote .blockquote-footer").innerHTML = currentAuthor;
  	});
})
});
