const { verifyToken, extractFromEvent } = require('../../shared/auth')
const { error, unauthorized } = require('../../shared/response')

const { listUsers, getUserDetail, adjustUserEnergy, listLeagues, getStats, getDashboard } = require('./users')
const { importFixtures, createGameweek, getGameweek, updateGameweek, publishGameweek, lockGameweek, unlockGameweek, resolveGameweek } = require('./gameweeks')
const { getOddsForFixture, listCompetitions, createCompetition, updateCompetition, deleteCompetition, getCompetitionCalendar, getCompetitionStandings, getFixtureDetails, getCompetitionGameweeks, getAvailableFixtures, importFixturesByRange, browseCompetitions, importCompetitionFromApi, refreshFixtureResults, getPublicScores, getPublicGameweek } = require('./competitions')
const { listDivisions, createDivision, updateDivision, getDivisionUsers, listSprints, createSprint, getSprint, updateSprint, activateSprint, addSprintGameweek, removeSprintGameweek, updateSprintGameweekDates, settleSprint, getRankings, recalculateSprintEntries } = require('./sprints')
const { listEnergyPacks, createEnergyPack, updateEnergyPack, deleteEnergyPack } = require('./energy')
const { debugDivisions, updateEvent, resettleEvent, fixBrokenWhoQualifies, fixDivisions } = require('./debug')

exports.handler = async (event) => {
  const routeKey = event.routeKey

  // Public routes — no auth required
  if (routeKey === "GET /competitions") {
    try { return await listCompetitions() }
    catch (err) { console.error(err); return error(500, "Internal server error") }
  }
  if (routeKey === "GET /scores") {
    try { return await getPublicScores(event) }
    catch (err) { console.error(err); return error(500, "Internal server error") }
  }
  if (routeKey === "GET /public/gameweek") {
    try { return await getPublicGameweek() }
    catch (err) { console.error(err); return error(500, "Internal server error") }
  }

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  if (user.role !== "admin") return error(403, "Admin only")

  try {
    if (routeKey === "GET /admin/fixtures")         return await importFixtures(event)
    if (routeKey === "POST /admin/gameweek")        return await createGameweek(event)
    if (routeKey === "GET /admin/gameweek/{id}")    return await getGameweek(event)
    if (routeKey === "PUT /admin/gameweek/{id}")    return await updateGameweek(event)
    if (routeKey === "POST /admin/publish")         return await publishGameweek(event)
    if (routeKey === "POST /admin/gameweeks/{id}/lock")    return await lockGameweek(event)
    if (routeKey === "POST /admin/gameweeks/{id}/unlock")  return await unlockGameweek(event)
    if (routeKey === "POST /admin/gameweeks/{id}/resolve")  return await resolveGameweek(event)
    if (routeKey === "GET /admin/users")            return await listUsers()
    if (routeKey === "GET /admin/users/{id}")       return await getUserDetail(event)
    if (routeKey === "POST /admin/users/{id}/energy") return await adjustUserEnergy(event)
    if (routeKey === "GET /admin/leagues")          return await listLeagues()
    if (routeKey === "GET /admin/stats")            return await getStats()
    if (routeKey === "GET /admin/dashboard")        return await getDashboard(event)
    if (routeKey === "GET /admin/odds")             return await getOddsForFixture(event)
    if (routeKey === "GET /admin/competitions")              return await listCompetitions()
    if (routeKey === "POST /admin/competitions")             return await createCompetition(event)
    if (routeKey === "PUT /admin/competitions/{id}")         return await updateCompetition(event)
    if (routeKey === "DELETE /admin/competitions/{id}")      return await deleteCompetition(event)
    if (routeKey === "GET /admin/competitions/{id}/calendar")   return await getCompetitionCalendar(event)
    if (routeKey === "GET /admin/competitions/{id}/gameweeks")  return await getCompetitionGameweeks(event)
    if (routeKey === "GET /admin/competitions/{id}/standings")  return await getCompetitionStandings(event)
    if (routeKey === "GET /admin/fixtures/{fixtureId}/details") return await getFixtureDetails(event)
    if (routeKey === "GET /admin/divisions")                           return await listDivisions()
    if (routeKey === "POST /admin/divisions")                          return await createDivision(event)
    if (routeKey === "PUT /admin/divisions/{id}")                      return await updateDivision(event)
    if (routeKey === "GET /admin/divisions/{id}/users")                return await getDivisionUsers(event)
    if (routeKey === "GET /admin/sprints")                             return await listSprints()
    if (routeKey === "POST /admin/sprints")                            return await createSprint(event)
    if (routeKey === "GET /admin/sprints/{id}")                        return await getSprint(event)
    if (routeKey === "PUT /admin/sprints/{id}")                        return await updateSprint(event)
    if (routeKey === "POST /admin/sprints/{id}/gameweeks")             return await addSprintGameweek(event)
    if (routeKey === "PATCH /admin/sprints/{id}/gameweeks/{gwId}")     return await updateSprintGameweekDates(event)
    if (routeKey === "DELETE /admin/sprints/{id}/gameweeks/{gwId}")    return await removeSprintGameweek(event)
    if (routeKey === "POST /admin/sprints/{id}/settle")                return await settleSprint(event, user)
    if (routeKey === "POST /admin/sprints/{id}/activate")              return await activateSprint(event)
    if (routeKey === "POST /admin/sprints/{id}/recalculate")           return await recalculateSprintEntries(event)
    if (routeKey === "GET /admin/rankings")                            return await getRankings(event)
    if (routeKey === "GET /admin/fixtures/available")                  return await getAvailableFixtures(event)
    if (routeKey === "POST /admin/fixtures/import-range")              return await importFixturesByRange(event)
    if (routeKey === "POST /admin/fixtures/refresh-results")           return await refreshFixtureResults(event)
    if (routeKey === "GET /admin/competitions/browse")                 return await browseCompetitions()
    if (routeKey === "POST /admin/competitions/import")                return await importCompetitionFromApi(event)
    if (routeKey === "GET /admin/energy-packs")          return await listEnergyPacks()
    if (routeKey === "POST /admin/energy-packs")         return await createEnergyPack(event)
    if (routeKey === "PUT /admin/energy-packs/{id}")     return await updateEnergyPack(event)
    if (routeKey === "DELETE /admin/energy-packs/{id}")  return await deleteEnergyPack(event)
    if (routeKey === "GET /admin/debug/divisions")       return await debugDivisions(event)
    if (routeKey === "POST /admin/debug/fix-divisions")           return await fixDivisions(event)
    if (routeKey === "PATCH /admin/events/{id}")                   return await updateEvent(event)
    if (routeKey === "POST /admin/events/{id}/resettle")          return await resettleEvent(event)
    if (routeKey === "POST /admin/debug/fix-who-qualifies")       return await fixBrokenWhoQualifies(event)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}
