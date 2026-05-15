const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const config = require("./config.js");
const movieModel = require("./movie-model.js");
const userModel = require("./user-model.js");

const app = express();

// Parse urlencoded bodies
app.use(bodyParser.json());

// Session middleware
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Serve static content in directory 'files'
app.use(express.static(path.join(__dirname, "files")));

app.post("/login", function (req, res) {
  const { username, password } = req.body;
  const user = userModel[username];
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = {
      username,
      firstName: user.firstName,
      lastName: user.lastName,
      loginTime: new Date().toISOString(),
    };
    res.send(req.session.user);
  } else {
    res.sendStatus(401);
  }
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.sendStatus(401);
  }

  next();
}

app.get("/logout", function (req, res) {
  req.session.destroy((err) => {
    if (err) {
      console.error("Failed to destroy session:", err);
      return res.sendStatus(500);
    }

    res.clearCookie("connect.sid");
    res.sendStatus(200);
  });
});

app.get("/session", function (req, res) {
  if (req.session.user) {
    res.send(req.session.user);
  } else {
    res.status(401).json(null);
  }
});

app.get("/movies", requireLogin, function (req, res) {
  const username = req.session.user.username;
  let movies = Object.values(movieModel.getUserMovies(username));
  const queriedGenre = req.query.genre;
  if (queriedGenre) {
    movies = movies.filter((movie) => movie.Genres.indexOf(queriedGenre) >= 0);
  }
  res.send(movies);
});

// Configure a 'get' endpoint for a specific movie
app.get("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  const movie = movieModel.getUserMovie(username, id);

  if (movie) {
    res.send(movie);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'put' endpoint for a specific movie to update or insert a movie
app.put("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const imdbID = req.params.imdbID;
  const exists = movieModel.getUserMovie(username, imdbID) !== undefined;

  if (!exists) {
    const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbID)}&apikey=${config.omdbApiKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

    fetch(url, { signal: controller.signal })
      .then(apiRes => {
        clearTimeout(timeoutId);
        if (!apiRes.ok) {
          return res.sendStatus(apiRes.status);
        }

        return apiRes.text().then(data => {
          let response;
          try {
            response = JSON.parse(data);
          } catch (parseError) {
            console.error("Failed to parse OMDb response:", parseError);
            return res.sendStatus(500);
          }

          if (response.Response !== "True") {
            return res.sendStatus(404);
          }

          const splitList = (value) => value && value !== "N/A"
            ? value.split(",").map(item => item.trim()).filter(Boolean)
            : [];
          const parseNumber = (value) => value && value !== "N/A" && !isNaN(value)
            ? Number(value)
            : null;

          const movie = {
            imdbID: response.imdbID,
            Title: response.Title,
            Released: response.Released && response.Released !== "N/A"
              ? new Date(response.Released).toISOString().slice(0, 10)
              : null,
            Runtime: response.Runtime && response.Runtime !== "N/A"
              ? parseInt(response.Runtime, 10)
              : 0,
            Genres: splitList(response.Genre),
            Directors: splitList(response.Director),
            Writers: splitList(response.Writer),
            Actors: splitList(response.Actors),
            Plot: response.Plot === "N/A" ? "" : response.Plot,
            Poster: response.Poster === "N/A" ? "" : response.Poster,
            Metascore: parseNumber(response.Metascore),
            imdbRating: parseNumber(response.imdbRating),
          };

          movieModel.setUserMovie(username, imdbID, movie);
          res.sendStatus(201);
        });
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (err.name === "AbortError") {
          console.error("OMDb API request timeout");
          return res.sendStatus(504);
        }
        console.error("OMDb API error:", err);
        res.sendStatus(500);
      });
  } else {
    if (req.body && Object.keys(req.body).length > 0) {
      movieModel.setUserMovie(username, imdbID, req.body);
    }
    res.sendStatus(200);
  }
});

app.delete("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  if (movieModel.deleteUserMovie(username, id)) {
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'get' endpoint for genres of all movies of the current user
app.get("/genres", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const genres = movieModel.getGenres(username);
  genres.sort();
  res.send(genres);
});

/* Task 2.1. Add the GET /search endpoint: Query omdbapi.com and return
   a list of the results you obtain. Only include the properties 
   mentioned in the README when sending back the results to the client. */
app.get("/search", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const query = req.query.query;
  if (!query) {
    return res.sendStatus(400);
  }

  const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${config.omdbApiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

  fetch(url, { signal: controller.signal })
    .then(apiRes => {
      clearTimeout(timeoutId);
      if (!apiRes.ok) {
        return res.sendStatus(apiRes.status);
      }
      return apiRes.text().then(data => {
        let response;
        try {
          response = JSON.parse(data);
        } catch (parseError) {
          console.error('Failed to parse OMDb response:', parseError);
          return res.sendStatus(500);
        }

        if (response.Response === 'True') {
          const results = response.Search
            .filter(movie => !movieModel.hasUserMovie(username, movie.imdbID))
            .map(movie => ({
              Title: movie.Title,
              imdbID: movie.imdbID,
              Year: isNaN(movie.Year) ? null : parseInt(movie.Year)
            }));
          res.send(results);
        } else {
          res.send([]);
        }
      });
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error('OMDb API request timeout');
        return res.sendStatus(504);
      }
      console.error('OMDb API error:', err);
      res.sendStatus(500);
    });
});

app.listen(config.port);

console.log(`Server now listening on http://localhost:${config.port}/`);
