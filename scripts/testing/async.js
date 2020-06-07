/*

const second = () => {
  setTimeout(() => {
    console.log('Oh...Hey There')
  }, 2000);
}

const first = () => {
  console.log('Hey There');
  second();
  console.log('The End');
}

first();



function getRecipe() {
  setTimeout(() => {
    const recipeID = [1,2,3,4,5];
    console.log(recipeID);

    setTimeout(id => {
      const recipe = {
        title: 'Fresh Spaghetti',
        publisher: 'Mikey and Manthi'};
        console.log(`${id}: ${recipe.title}`);

        setTimeout(publisher => {
          const recipe2 = {
            title: 'Italian Pizza',
            publisher: 'Mikey'};
            console.log(recipe);
        }, 750, recipe.publisher);
      }, 500, recipeID[2]);
  }, 150);
}

getRecipe();



const getID = new Promise((resolve, reject) => {
  setTimeout(() => {
    resolve([351, 253, 353, 634, 535]);
  }, 1);
});

const getRecipe = recID => {
  return new Promise((resolve, reject) => {
  setTimeout(ID => {
        const recipe = {
        title: 'Fresh Tomato Pasta',
        author: 'Mikey & Manthi'
      };
      resolve(`${ID}: ${recipe.title}`);
    }, 1.5, recID);
  });
};

const getRelated = author => {
  return new Promise((resolve, reject) => {
  setTimeout(author => {
        const recipe = {
        title: 'Italian Pizza',
        author: 'Mikey & Manthi'
      };
      resolve(`${author}: ${recipe.title}`);
    }, 1.5, author);
  });
};

getID
  .then(data => {
    console.log(data);
    return getRecipe(data[2]);
  })
  .then(recipe => {
    console.log(recipe);
    return getRelated('Mikey & Manthi');
  })
  .then(recipe => {
    console.log('related recipes')
    console.log(recipe)
  })
  .catch(error => {
    console.log('error!');
  });

*/
function getWeather(woeid) {
fetch('https://www.metaweather.com/api/location/' + woeid)
.then(result => {
  // console.log(result);
  return result.json();
})
.then(data => {
   //console.log(data);
  const today = data.consolidated_weather[0];
  const cToF = temp => {return ((temp * 9 / 5) + 32)};
  document.body.append(`Temperatures in ${data.title} are between ${Math.round(today.min_temp)} and ${Math.round(today.max_temp)} degrees celsius today.`);
	document.body.append(document.createElement('br'));
  document.body.append(`That is ${Math.round(cToF(today.min_temp))} and ${Math.round(cToF(today.max_temp))} degrees in fahrenheit.`);
	document.body.append(document.createElement('br'));
})
.catch(error => console.log(error));
}
document.querySelector("form").addEventListener("submit",function(e){
						e.preventDefault();
            getWeather(document.querySelector('#id').value)
});
getWeather('1225448');
getWeather('2514815');
